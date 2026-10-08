// src/routes.ts
// Every HTTP endpoint in the lab, heavily commented.
// Each route references the README part it demonstrates.

import { Router } from "express";
import { redis } from "./lib/redis";
import { db } from "./lib/db";

const router = Router();

// ===========================================================================
// PART 5 + 6: CACHE HIT / MISS + CACHE-ASIDE
// GET /products/:id
//
// Flow:
//   Redis GET
//      |
//   HIT? --yes--> respond from cache (no database query at all)
//      |
//      no
//      v
//   PostgreSQL query --> Redis SET (with TTL) --> respond
// ===========================================================================
router.get("/products/:id", async (req, res) => {
  const id = req.params.id;
  const cacheKey = `product:${id}`;

  // ---- Step 1: ask Redis first (this is one network round trip, ~0.2ms) ----
  const cached = await redis.get(cacheKey);

  if (cached) {
    // CACHE HIT: the data never touches PostgreSQL.
    console.log(`CACHE HIT      key=${cacheKey}`);
    return res.json(JSON.parse(cached));
  }

  // ---- Step 2: miss -> only now we pay for the database ----
  console.log(`CACHE MISS     key=${cacheKey}`);
  console.log(`DATABASE QUERY SELECT * FROM products WHERE id = ${id}`);

  const result = await db.query("SELECT * FROM products WHERE id = $1", [id]);

  if (result.rows.length === 0) {
    // NOTE: we deliberately do NOT cache "not found" here.
    // That is cache penetration - see src/caching/negative-cache.ts.
    return res.status(404).json({ message: "Product not found" });
  }

  const product = result.rows[0];

  // ---- Step 3: store the DB result in Redis so the NEXT request hits ----
  // EX 60 = expire after 60 seconds (see README Part 7: TTL).
  await redis.set(cacheKey, JSON.stringify(product), { EX: 60 });

  return res.json(product);
});

// ===========================================================================
// PART 8: CACHE INVALIDATION
// PUT /products/:id
//
// Rule of thumb: on every DB write -> DELETE the related cache key.
//   DB UPDATE  ->  DEL product:<id>
//
// Why delete and not update?
//   - delete is safe: next read rebuilds the cache from the source of truth
//   - update can race: two writers, the slower "update" overwrites newer data
// ===========================================================================
router.put("/products/:id", async (req, res) => {
  const id = req.params.id;
  const { name, price } = req.body ?? {};

  if (typeof name !== "string" || typeof price !== "number") {
    return res.status(400).json({ message: "Send {name, price}" });
  }

  const result = await db.query(
    `UPDATE products SET name = $1, price = $2 WHERE id = $3 RETURNING *`,
    [name, price, id],
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ message: "Product not found" });
  }

  // Delete the stale cache entry. If this DEL fails, the old value survives
  // until its TTL expires -> that is why TTL still matters (README Part 7).
  await redis.del(`product:${id}`);
  console.log(`CACHE INVALIDATED  key=product:${id}`);

  return res.json(result.rows[0]);
});

// ===========================================================================
// PART 16: ATOMIC OPERATIONS (counter)
// POST /views/:productId
//
// INCR is atomic: Redis executes it in its single thread, so N app servers
// incrementing the same key can never lose an update (unlike read-modify-write
// in application code: x = x + 1 is NOT atomic across processes).
// ===========================================================================
router.post("/views/:productId", async (req, res) => {
  const key = `product:${req.params.productId}:views`;
  const views = await redis.incr(key); // atomic +1
  return res.json({ key, views });
});

// ===========================================================================
// PART 17: RATE LIMITING - fixed window
// GET /rate/:userId     -> 5 requests per minute per user
//
//   INCR  rate:<user>:<window>       <- count this request
//   EXPIRE rate:<user>:<window> 60   <- let the window reset after 1 min
//
// The race condition (EXPIRE not running after a crash) and the atomic
// fix (Lua) are shown in src/rate-limiting/fixed-window.ts.
// ===========================================================================
const RATE_LIMIT = 5;
const WINDOW_SECONDS = 60;

router.get("/rate/:userId", async (req, res) => {
  const userId = req.params.userId;
  const windowId = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `rate:${userId}:${windowId}`;

  // INCR returns the new count. First call on a fresh key returns 1.
  const count = await redis.incr(key);

  // Only set the expiry when this is the FIRST hit of the window,
  // otherwise every request would push the window forward forever.
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  const allowed = count <= RATE_LIMIT;

  console.log(
    `RATE ${allowed ? "ALLOW" : "BLOCK"} user=${userId} count=${count}/${RATE_LIMIT}`,
  );

  return res.status(allowed ? 200 : 429).json({
    user: userId,
    count,
    limit: RATE_LIMIT,
    allowed,
    retryAfterSeconds: allowed ? undefined : WINDOW_SECONDS,
  });
});

// ===========================================================================
// PART 18: IDEMPOTENCY
// POST /payments   header: Idempotency-Key: <unique-string>
//
// Problem: a client retries a payment because the response was lost.
// The money must NOT be captured twice.
//
// Solution with Redis:
//   SET idem:<key> pending NX EX 300   -> "first request wins"
//   ... do the work ...
//   SET idem:<key> <result> EX 300     -> store the result
//
// Retry with the same key -> we see the stored result and skip the work.
// Full failure-case analysis: src/atomic/idempotency.ts
// ===========================================================================
router.post("/payments", async (req, res) => {
  const idemKey = req.get("Idempotency-Key");

  if (!idemKey) {
    return res.status(400).json({
      message: "Missing Idempotency-Key header (required for retries)",
    });
  }

  const redisKey = `idem:${idemKey}`;

  // SET ... NX = only set if the key does NOT exist (atomic check-and-set).
  const first = await redis.set(redisKey, "pending", { NX: true, EX: 300 });

  if (first !== "OK") {
    // Somebody (maybe this exact request earlier) already owns this key.
    const stored = await redis.get(redisKey);

    if (stored === "pending") {
      // Original request still in flight -> tell client to retry later.
      return res.status(409).json({
        status: "in_progress",
        message: "Same request is still being processed, retry shortly",
      });
    }

    // Finished earlier -> replay the stored answer, execute NOTHING new.
    return res.status(200).json({
      status: "replayed",
      original: JSON.parse(stored ?? "{}"),
    });
  }

  // --- We own the key. Do the real (fake) work exactly once. ---
  const { userId, amount } = req.body ?? {};
  if (typeof userId !== "string" || typeof amount !== "number") {
    await redis.del(redisKey); // release the key so the client can retry
    return res.status(400).json({ message: "Send {userId, amount}" });
  }

  const { rows } = await db.query(
    `INSERT INTO orders (user_id, amount, status) VALUES ($1, $2, 'paid') RETURNING *`,
    [userId, amount],
  );
  const order = rows[0];

  // Store the final result instead of "pending" (same key, same TTL).
  await redis.set(redisKey, JSON.stringify(order), { EX: 300 });

  console.log(`PAYMENT PROCESSED key=${redisKey} order=${order.id}`);
  return res.status(201).json({ status: "created", order });
});

export default router;
