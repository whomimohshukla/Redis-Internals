# Redis Coding Exercises (Interview Practice)

Ten exercises in the order they usually come up in backend interviews: caching, rate
limiting, locks, idempotency, streams, leaderboards, counters. Every solution is real
TypeScript on the `redis` npm package v4+ promise API (`createClient`, `await redis.connect()`,
`await redis.get/set/del/incr`, `redis.set(key, val, { EX: 60, NX: true })`) - the same style
used everywhere in `src/`.

**How to use this document**

1. Attempt the exercise on your own (scratch file or whiteboard) *before* reading the solution.
2. Run the matching example under `src/` to watch the same flow live against a real Redis.
3. Read the explanation, then answer the follow-up questions out loud - that is the actual interview rep.
4. Re-solve the exercise a day later from memory; if you stall, reread only the explanation.
5. All code below assumes a connected shared client: `import { redis } from "../lib/redis"`.

## How to run the matching src examples

Every exercise maps to a runnable script already wired up in `package.json`:

```bash
npm run cache:aside           # Exercise 1  - src/caching/cache-aside.ts
npm run cache:invalidation    # Exercise 2  - src/caching/invalidation.ts
npm run ratelimit:fixed       # Exercise 3  - src/rate-limiting/fixed-window.ts
npm run lock:distributed      # Exercise 4  - src/locks/distributed-lock.ts
npm run lock:safe-release     # Exercise 4  - src/locks/safe-lock-release.ts
npm run atomic:idempotency    # Exercise 5  - src/atomic/idempotency.ts
npm run stream:producer       # Exercise 6  - src/streams/producer.ts
npm run stream:consumer       # Exercise 7  - src/streams/consumer.ts
npm run stream:group          # Exercise 7  - src/streams/consumer-group.ts
npm run stream:retry          # Exercise 8  - src/streams/retry.ts
npm run basics:sorted-sets    # Exercise 9  - src/basics/sortedSets.ts
npm run atomic:counter        # Exercise 10 - src/atomic/counter.ts
```

Handy extras: `npm run redis:reset` (wipe Redis between runs), `npm run typecheck`
(tsc over `src/`), `npm run ex -- src/caching/ttl.ts` (run any file ad hoc).

---

## Exercise 1 - getProduct() with cache-aside

**Problem:** Implement `getProduct(id, db)` using the cache-aside pattern: read from Redis
first, fall back to the database on a miss, and populate the cache with a TTL. Mention where
an invalidation hook belongs in the write path.

**Expected solution:**
- Build the key (`product:${id}`) and `GET` it - one round trip, no DB touched on a hit.
- On a miss, query the database (source of truth).
- If the row exists, `SET` it back into Redis with a TTL (bounded staleness) before returning.
- If the row does not exist, return `null` without caching (a cached "missing" marker is
  cache penetration - covered separately as negative caching).
- The write path calls `invalidateProduct(id)` after every DB update (Exercise 2).

**Code:**

```ts
import { redis } from "../lib/redis";

type Product = { id: string; name: string; priceCents: number };
type ProductDb = { findProduct(id: string): Promise<Product | null> };

const PRODUCT_TTL_SEC = 60; // worst case: a user sees a 60s-old product

export async function getProduct(id: string, db: ProductDb): Promise<Product | null> {
  const key = `product:${id}`;

  // 1. cache lookup - one Redis round trip (~0.2ms on a LAN)
  const cached = await redis.get(key);
  if (cached !== null) {
    return JSON.parse(cached) as Product; // HIT: the database is never touched
  }

  // 2. MISS - fall back to the source of truth
  const product = await db.findProduct(id);
  if (product === null) return null; // deliberately not cached (penetration)

  // 3. populate with a TTL so the entry heals itself if we crash later
  await redis.set(key, JSON.stringify(product), { EX: PRODUCT_TTL_SEC });

  return product;
}

// Invalidation hook: the write path calls this right after the DB commit.
export async function invalidateProduct(id: string): Promise<void> {
  await redis.del(`product:${id}`);
}
```

**Explanation:** On a hit the function costs exactly one Redis `GET` and returns the parsed
JSON - PostgreSQL never runs, which is the whole point of cache-aside. On a miss we pay for
the database query and then immediately write the result back with `EX 60`, so the next read
of that product is a hit for the next minute. The TTL is not decoration: if the process dies
before it can invalidate, or an operator edits the row directly, the key still expires on its
own, which bounds staleness. Notice there is no lock around the miss - a few concurrent
misses may all query the DB and write the same value (cache stampede), which is a separate,
deliberate trade-off you should be able to discuss (see `src/patterns/cache-stampede.ts`).

**Complexity:** Hit: O(1) server-side, 1 network round trip, 0 DB queries. Miss: 1 `GET` +
1 DB query + 1 `SET` = 2 Redis round trips plus database time. Space: one JSON string per
product (typically a few hundred bytes to a few KB) while it lives, auto-reclaimed by the TTL.

**Interview follow-ups:**
- **Q: What happens if the DB write fails after the cache was invalidated?** A: Nothing is
  corrupted - the next read is just a miss and repopulates from the unchanged row.
- **Q: If you invalidate explicitly, why also set a TTL?** A: The TTL is the backstop for
  paths that forget to invalidate (out-of-band updates, crashes); explicit `DEL` only keeps
  the average staleness near zero.
- **Q: Should a "not found" be cached?** A: Yes, but briefly (30-60s `SETNX` marker) -
  caching it forever lets one typo ID poison the cache, not caching it at all is penetration.
- **Q: Is JSON the right value format?** A: It is portable and versionable; MessagePack or
  a Redis hash are alternatives, but the cost driver is bytes on the wire, not the format.

---

## Exercise 2 - invalidateProduct() after a DB write

**Problem:** Implement `invalidateProduct(id)` and wire it into an `updateProduct` write
path. Discuss the delete-vs-update race and why TTL remains necessary even with perfect
invalidation code.

**Expected solution:**
- After the DB commit succeeds, `DEL product:${id}` - one command, O(1).
- Invalidate *after* the commit, not before (see explanation for why).
- A concurrent reader can still refill the cache with a stale row it read *before* the
  commit - that race is the reason the TTL backstop exists.
- Optional hardening: delete again after a short delay ("double delete") or version the
  cached payload so stale writers can detect they lost.

**Code:**

```ts
import { redis } from "../lib/redis";

type Product = { id: string; name: string; priceCents: number };
type ProductPatch = Partial<Product>;
type ProductDb = {
  findProduct(id: string): Promise<Product | null>;
  updateProduct(id: string, patch: ProductPatch): Promise<Product>;
  deleteProduct(id: string): Promise<void>;
};

export async function invalidateProduct(id: string): Promise<void> {
  await redis.del(`product:${id}`); // O(1); UNLINK if your payloads are huge
}

export async function updateProduct(
  id: string,
  patch: ProductPatch,
  db: ProductDb
): Promise<Product> {
  const updated = await db.updateProduct(id, patch); // 1. commit first
  await invalidateProduct(id); // 2. only now drop the stale entry
  return updated;
}

export async function removeProduct(id: string, db: ProductDb): Promise<void> {
  await db.deleteProduct(id);
  await invalidateProduct(id); // same delete-after-commit ordering
}
```

**Explanation:** The ordering matters: if you delete the cache *before* committing and the
commit then fails, a reader between the two steps repopulates the cache with the old row and
it stays for a full TTL. Delete-after-commit means the worst outcome of a failed commit is an
untouched, still-correct cache. The remaining race is the classic one: reader A does `GET`
(miss), reads the pre-update row, the writer commits and deletes the key, then reader A writes
its now-stale row back into the cache - one stale entry surviving up to the TTL. In practice
that is accepted (the TTL is the backstop) or closed with a delayed second `DEL`, a
version/etag inside the value, or write-through updates. `DEL` on a plain string key is O(1);
for very large values prefer `UNLINK`, which unlinks in O(1) and frees memory in a background
thread.

**Complexity:** 1 DB write + 1 Redis round trip for `DEL`, O(1) time, O(1) space (it frees
the key). Total staleness window: ~0 for well-behaved paths, at most one TTL for the race.

**Interview follow-ups:**
- **Q: Delete-before-write or write-then-delete?** A: Write-then-delete; deleting first lets
  a concurrent reader cache the pre-commit row with no chance of correction until the TTL.
- **Q: How bad is the stale-refill race for a product page?** A: Usually acceptable - one
  reader sees an old price for up to the TTL; unacceptable for payments, which is why
  transactional reads go to the DB or use a short-lived lock.
- **Q: What if invalidation is simply forgotten in one service?** A: TTL bounds the damage to
  one TTL period, and a versioned key (`product:v3:${id}`) or a global cache-generation key
  can invalidate everything at once.
- **Q: `DEL` vs `UNLINK`?** A: `DEL` frees inline (a 50MB value blocks the single thread);
  `UNLINK` returns immediately and frees asynchronously.

---

## Exercise 3 - rateLimiter(): fixed window with INCR + EXPIRE

**Problem:** Build `rateLimiter(userId, limit, windowSec)` allowing **5 requests per 60
seconds per user** with a fixed window counter. Show the atomic Lua variant briefly.

**Expected solution:**
- Key the counter by user *and* window slot: `rl:${userId}:${slot}` where
  `slot = floor(now / 1000 / windowSec)` - old windows expire naturally.
- `INCR` the key; if the result is `1`, this is the first request of the window, so set
  `EXPIRE windowSec` (the key must not outlive its window).
- Reject when the counter exceeds the limit; report `remaining` for the client.
- Lua variant: run `INCR` + conditional `EXPIRE` inside one script so a crash between the
  two commands can never leave an immortal counter.

**Code:**

```ts
import { redis } from "../lib/redis";

type Decision = { allowed: boolean; remaining: number; retryAfterSec: number };

export async function rateLimiter(
  userId: string,
  limit = 5,
  windowSec = 60
): Promise<Decision> {
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${userId}:${slot}`;

  const count = await redis.incr(key); // atomic: no read-modify-write race
  if (count === 1) {
    // first hit of this window starts the clock.
    // If the process dies here the key would live forever -> Lua variant below.
    await redis.expire(key, windowSec);
  }
  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfterSec: allowed ? 0 : windowSec - (Math.floor(Date.now() / 1000) % windowSec),
  };
}

const LUA_FIXED_WINDOW = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n
`;

export async function rateLimiterAtomic(userId: string, limit = 5, windowSec = 60): Promise<boolean> {
  const key = `rl:${userId}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const count = Number(
    await redis.eval(LUA_FIXED_WINDOW, { keys: [key], arguments: [String(windowSec)] })
  );
  return count <= limit; // INCR and EXPIRE happened as one server-side script
}
```

**Explanation:** The window slot goes *into* the key, so there is no cleanup job: when the
window rolls over the old key is simply no longer referenced by any `INCR` and expires via
its TTL. `INCR` is the crux - Redis executes it as a single atomic operation, so two
simultaneous requests from different servers can never both read "4" and both write "5"; a
`GET` + `SET` pair in application code would lose updates. The weak spot is the gap between
`INCR` and `EXPIRE`: if the process dies in between, the counter has no TTL and would block
the user forever (in the slot's lifetime). The Lua script closes that gap because Redis runs
the whole script atomically without interleaving other commands - and it still costs a single
round trip.

**Complexity:** 1-2 round trips per request, O(1) time each; the Lua form is 1 round trip.
Space: one small integer key per user per window, reclaimed by TTL. Fixed windows allow a
burst of up to `2 * limit` across a window boundary (5 before + 5 after the edge).

**Interview follow-ups:**
- **Q: Why not `GET` then `SET`?** A: Two app servers can interleave between the read and
  the write and both let a request through; `INCR` makes read-modify-write one atomic step.
- **Q: What is the fixed-window burst problem?** A: A client can send 5 requests at the end
  of one window and 5 at the start of the next (10 in ~1 second) - fixed by a sliding window
  log or sliding-window counter (see `src/rate-limiting/sliding-window.ts`).
- **Q: Pipeline or Lua for INCR+EXPIRE?** A: A pipeline only batches round trips; the two
  commands still execute separately. Only Lua (or `MULTI`) makes them atomic, and Lua is the
  simpler choice for two commands.
- **Q: Redis restarts - what happens to the counters?** A: They are lost, so you must decide
  explicitly to fail open (allow traffic) or fail closed (block), usually fail open.

---

## Exercise 4 - distributedLock() with SET NX EX and a safe release

**Problem:** Implement `distributedLock(resource, ttlSec)` - acquire a lock with `SET ... NX
EX` using a unique token, and release it only if the lock still holds *your* token.

**Expected solution:**
- Generate a unique token (`randomUUID()`) per acquisition attempt.
- Acquire with `SET lock:${resource} ${token} NX EX ${ttl}` - `NX` guarantees one winner,
  `EX` guarantees the lock dies if the holder crashes.
- Return a release closure bound to that token.
- Release with a Lua script: `GET` the key, compare to my token, `DEL` only on match - a
  non-atomic `GET` then `DEL` could delete a lock that has since been taken by someone else.

**Code:**

```ts
import { randomUUID } from "node:crypto";
import { redis } from "../lib/redis";

export type LockHandle = { resource: string; token: string; release: () => Promise<boolean> };

export async function distributedLock(resource: string, ttlSec = 10): Promise<LockHandle | null> {
  const token = randomUUID(); // unique to this acquisition, not to the resource
  const ok = await redis.set(`lock:${resource}`, token, { NX: true, EX: ttlSec });
  if (ok !== "OK") return null; // someone else holds it -> caller backs off
  return { resource, token, release: () => releaseLock(resource, token) };
}

const LUA_SAFE_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export async function releaseLock(resource: string, token: string): Promise<boolean> {
  const result = await redis.eval(LUA_SAFE_RELEASE, {
    keys: [`lock:${resource}`],
    arguments: [token],
  });
  return result === 1; // 1 = I released my lock, 0 = it was not mine anymore
}

export async function withLock<T>(resource: string, ttlSec: number, job: () => Promise<T>): Promise<T | null> {
  const lock = await distributedLock(resource, ttlSec);
  if (lock === null) return null;
  try {
    return await job();
  } finally {
    await lock.release(); // always attempt release; TTL covers the crash case
  }
}
```

**Explanation:** `SET key token NX EX 10` is the entire acquire path: `NX` makes exactly one
of N competing servers receive `"OK"`, and `EX` attaches the expiry in the same command -
doing `SETNX` and `EXPIRE` as two commands would leave a window where a crash creates a
permanent lock. The token is what makes release safe: without it, a worker whose lock
expired (because its job ran too long) would `DEL` the lock that a *second* worker now holds,
giving two workers the same lock. The Lua script runs atomically on the server, so the
compare-and-delete cannot interleave with another client's acquire. `withLock` shows the
usual shape: `try/finally` so release runs even if the job throws; if the process dies, the
TTL is the release.

**Complexity:** Acquire: 1 round trip, O(1). Release: 1 round trip (one `EVAL` doing
GET+DEL), O(1). Space: 1 string key per held lock. Contention cost is on the *caller* -
spin/backoff/queue while `NX` fails - not on the server.

**Interview follow-ups:**
- **Q: Why not just `DEL` on release?** A: Your lock may have expired and been re-acquired;
  an unconditional `DEL` would release someone else's lock. The token check prevents that.
- **Q: TTL too short for a long job?** A: The lock expires mid-job and a second worker joins
  - use a heartbeat thread that extends the TTL (e.g. `EXPIRE` every TTL/3) and still treat
  the work as at-least-once.
- **Q: Is this lock safe under a network partition?** A: It is best-effort: a paused worker
  can wake after its TTL expired and keep mutating state. Strict safety needs fencing tokens
  checked by the storage layer (or a consensus store like etcd/ZooKeeper).
- **Q: `SET NX EX` vs `SETNX` + `EXPIRE`?** A: Two commands are not atomic - a crash between
  them leaves a lock with no expiry; `SET` with both flags is a single atomic command.

---

## Exercise 5 - idempotency() with an Idempotency-Key

**Problem:** Implement `idempotency(idemKey, ...)` for a payment-like endpoint: the client
sends an `Idempotency-Key` header; the first request executes, concurrent duplicates wait,
and later replays return the stored result instead of charging twice.

**Expected solution:**
- `SET idem:${key} PENDING NX EX <ttl>` - only the first request wins the right to execute.
- Losers read the key: `"PENDING"` means "still running" (tell the client to retry), a JSON
  payload means "replayed result" - return it verbatim.
- On success, overwrite the key with the serialized result (same TTL = replay window).
- On failure, `DEL` the key so the client's retry is allowed to execute; otherwise a failed
  request would be cached as its own answer.

**Code:**

```ts
import { redis } from "../lib/redis";

type ChargeResult = { chargeId: string; status: "succeeded" | "failed" };
type ChargeFn = (userId: string, amountCents: number) => Promise<ChargeResult>;
type IdemOutcome = ChargeResult | { status: "in_progress" };

const REPLAY_TTL_SEC = 60 * 60 * 24; // keep results for 24h = the replay window

export async function idempotency(
  idemKey: string,
  userId: string,
  amountCents: number,
  charge: ChargeFn
): Promise<IdemOutcome> {
  const key = `idem:${idemKey}`;

  // 1. claim the key - exactly one request gets to execute
  const claimed = await redis.set(key, "PENDING", { NX: true, EX: REPLAY_TTL_SEC });

  if (claimed !== "OK") {
    const existing = await redis.get(key);
    if (existing === null) return { status: "in_progress" }; // expired mid-flight: retry
    if (existing === "PENDING") return { status: "in_progress" }; // duplicate: still running
    return JSON.parse(existing) as ChargeResult; // replay the stored result
  }

  try {
    const result = await charge(userId, amountCents); // the real side effect
    await redis.set(key, JSON.stringify(result), { EX: REPLAY_TTL_SEC }); // publish it
    return result;
  } catch (err) {
    await redis.del(key); // free the key so an honest retry may run again
    throw err;
  }
}
```

**Explanation:** `SET ... NX` is the whole concurrency primitive: for a burst of five
identical requests, one writes `"PENDING"` and gets `"OK"`, the other four read `"PENDING"`
and are told to wait rather than charging again. Once the winner finishes, the key holds the
JSON result, so a client that timed out and retried three minutes later gets the *same*
response body - this is exactly how Stripe-style APIs behave. The `try/catch` around the
side effect is what keeps the system honest: a transient failure must not be memoized as a
permanent answer, so we delete the key and let the retry through. The TTL doubles as the
replay window - pick it longer than the client's retry horizon (24h here) or late replays
will re-execute.

**Complexity:** 1-2 round trips per call (`SET NX`, plus `GET` on the duplicate path),
O(1) time and O(1) space per key, auto-expired after the replay window. The duplicate path
never touches the payment system.

**Interview follow-ups:**
- **Q: Two requests race - what does the loser see?** A: `{ status: "in_progress" }` (an HTTP
  409 or 202 with `Retry-After` in a real API) until the winner publishes its result.
- **Q: Why store `"PENDING"` at all?** A: It distinguishes "executing right now" from "key
  never seen", so concurrent duplicates are not mistaken for replays and are not allowed to
  start a second execution.
- **Q: Crash after the charge succeeds but before the `SET`?** A: The key stays `"PENDING"`
  until TTL - the retry gets `in_progress` and eventually the operator reconciles; the robust
  fix is to make the underlying charge itself idempotent (unique constraint on `idemKey`).
- **Q: What if the TTL is shorter than the client's retry window?** A: The key vanishes and a
  retry executes the operation a second time - always size the TTL above the retry horizon.

---

## Exercise 6 - Stream producer with XADD and MAXLEN ~

**Problem:** Write `produceOrderEvent(event)` that appends an `order.created` event to the
`orders` stream, trimming it to roughly the last 100,000 entries.

**Expected solution:**
- `XADD orders * {fields}` - `*` lets the server generate the monotonic id
  (`<unix-ms>-<seq>`), which is unique and ordered even across many producers.
- Stream fields are strings, so numbers are sent as strings and decoded by the consumer.
- Trim on write with `TRIM MAXLEN ~ 100000`: `~` lets Redis trim in whole macro-nodes
  (near-O(1)) instead of counting entries exactly, so appends stay cheap.
- Return the entry id - callers store it as a cursor / correlation id.

**Code:**

```ts
import { redis } from "../lib/redis";

export type OrderCreated = {
  orderId: string;
  userId: string;
  totalCents: number;
};

export async function produceOrderEvent(event: OrderCreated): Promise<string> {
  const entryId = await redis.xAdd(
    "orders",
    "*", // server-side id: <unix-ms-timestamp>-<sequence>
    {
      type: "order.created",
      orderId: event.orderId,
      userId: event.userId,
      totalCents: String(event.totalCents), // stream entries are string maps
    },
    {
      // keep roughly the last 100k entries; "~" trades exactness for speed
      TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100_000 },
    }
  );
  return entryId; // e.g. "1712345678901-0"
}

export async function produceOrderEvents(events: OrderCreated[]): Promise<string[]> {
  const ids: string[] = [];
  for (const event of events) ids.push(await produceOrderEvent(event)); // pipeline this in real code
  return ids;
}

export async function streamLength(): Promise<number> {
  return redis.xLen("orders"); // O(1) - never scan the stream to count it
}
```

**Explanation:** `XADD` appends to a radix tree keyed by the entry id, so appending is O(1)
and reading a range by id later is cheap. Letting the server mint the id with `*` avoids the
dreaded "producer clock skew" problem: ids are `<timestamp>-<sequence>`, unique and strictly
increasing per stream regardless of how many nodes write. The `TRIM` option runs inside the
same `XADD`, so the stream never grows without bound - without it a forgotten consumer (or a
consumer group nobody reads from) means unbounded memory. `~` means "approximately": Redis
frees complete macro-nodes rather than walking entry-by-entry, so trimming costs almost
nothing and the stream may sit slightly above 100k entries. Consumers never `XADD`-read in
the same place: this entry sits in the stream until a group reads and acks it (Exercises
7-8) or trimming evicts it.

**Complexity:** O(1) per append (amortized), plus O(evicted) when trimming actually fires -
which the `~` modifier keeps tiny. One round trip per event; in bulk, pipeline the `XADD`s
to pay one round trip for many entries. Space: bounded by `MAXLEN` times average entry size.

**Interview follow-ups:**
- **Q: `MAXLEN ~` vs `MAXLEN =`?** A: `=` must count and trim exactly on every write, which
  is O(N) work; `~` frees whole macro-nodes and is effectively O(1), at the cost of a small
  overshoot.
- **Q: What happens if the consumer is down for an hour?** A: Entries survive in the stream
  until trimming evicts them; with a consumer group they also sit in the PEL, which is what
  Exercise 8's retry logic is for.
- **Q: Why streams instead of `LPUSH` + `BLPOP`?** A: Lists are destructive - one consumer
  gets each item; streams support multiple independent consumer groups, replay by id, and
  pending/ack bookkeeping for at-least-once delivery.
- **Q: Who pays for trimming?** A: The producer, inside `XADD` - that is why the approximate
  mode exists; heavy exact trimming on a hot key shows up as producer latency.

---

## Exercise 7 - Consumer group: XGROUP CREATE, XREADGROUP, XACK

**Problem:** Write a consumer that joins the `billing` group on the `orders` stream, reads
batches of entries, processes them, and acknowledges only after successful processing.

**Expected solution:**
- Create the group once with `XGROUP CREATE orders billing 0 MKSTREAM`, tolerating
  `BUSYGROUP` (the group already exists) when several instances start together.
- Read new entries with `XREADGROUP GROUP billing worker-1 COUNT n BLOCK ms STREAMS orders >`
  (`>` = only never-delivered entries).
- Process business logic first, then `XACK` - acknowledging before processing loses the
  message if the worker crashes (at-most-once, which is wrong for billing).
- Handle `null`/empty replies: `BLOCK` timed out and there is simply nothing to do.

**Code:**

```ts
import { redis } from "../lib/redis";

const STREAM = "orders";
const GROUP = "billing";
const CONSUMER = process.env.CONSUMER_NAME ?? "worker-1";

export async function ensureGroup(): Promise<void> {
  try {
    await redis.xGroupCreate(STREAM, GROUP, "0", { MKSTREAM: true }); // start from the head
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("BUSYGROUP")) throw err; // BUSYGROUP = group already exists: fine
  }
}

type StreamMsg = { id: string; message: Record<string, string> };

export async function consumeBatch(count = 10): Promise<StreamMsg[]> {
  const res = await redis.xReadGroup(
    GROUP,
    CONSUMER,
    { key: STREAM, id: ">" }, // ">" = only entries never delivered to this group
    { COUNT: count, BLOCK: 2000 } // block up to 2s so the loop stays event-driven
  );
  if (res === null) return []; // BLOCK timed out: no new entries
  return res[0]?.messages ?? [];
}

export async function processAndAck(msg: StreamMsg): Promise<void> {
  await creditInvoice(msg.message); // side effect first...
  await redis.xAck(STREAM, GROUP, msg.id); // ...ack only after it succeeded
}

const billed = new Set<string>();

async function creditInvoice(message: Record<string, string>): Promise<void> {
  const orderId = message.orderId ?? "";
  if (billed.has(orderId)) return; // XREADGROUP may deliver an entry more than once
  billed.add(orderId); // real code: INSERT INTO invoices (order_id) ... unique(order_id)
}
```

**Explanation:** `XGROUP CREATE ... 0 MKSTREAM` records a group with its own last-delivered
id, starting at the beginning of the stream (use `$` to only see entries produced *after*
creation); `MKSTREAM` creates the stream if it does not exist yet, so boot order never
matters. `XREADGROUP ... >` hands each entry to exactly one consumer *in that group* -
another group (say `shipping`) would receive its own full copy. Delivered entries move to
the group's Pending Entries List (PEL) with the consumer's name and a delivery counter;
`XACK` removes them. The order in the last function is the lesson: process, then ack. That
gives at-least-once delivery - duplicates are possible (a crash between the side effect and
`ACK`), which is why the handler keys on `orderId` to dedupe.

**Complexity:** Group creation: 1 round trip, O(1). Each read: 1 round trip returning up to
`COUNT` entries, O(M) in entries returned (constant if `COUNT` is fixed). Each message costs
1 round trip for `XACK` (or 0 if you use `NOACK`). Group bookkeeping is O(1) per entry.

**Interview follow-ups:**
- **Q: What is the difference between `0` and `>` in XREADGROUP?** A: `>` replays history -
  every entry the group has not acked yet (including previously delivered, still-pending ones);
  `>` delivers only entries never given to any consumer.
- **Q: Ack before or after processing?** A: After - ack-first is at-most-once and silently
  drops messages on a crash; ack-after is at-least-once and forces idempotent handlers.
- **Q: Three workers, one group - who gets each entry?** A: Exactly one of them, chosen by
  Redis; entries are load-balanced across consumers, not broadcast.
- **Q: Why not `BLOCK 0`?** A: The consumer would block forever and could not run shutdown
  hooks, health checks or periodic retries - use a finite block and loop.

---

## Exercise 8 - Retry for failed stream messages (XPENDING + XCLAIM / XAUTOCLAIM)

**Problem:** Recover messages that were delivered but never acked (worker crashed mid-job):
find them with `XPENDING`, reclaim them with `XCLAIM`/`XAUTOCLAIM`, redeliver them, cap the
number of retries and route exhausted messages to a dead-letter queue.

**Expected solution:**
- Periodically scan the PEL with `XAUTOCLAIM key group me <minIdle> 0 COUNT n` - it finds
  entries idle longer than `minIdleMs` and transfers them to this consumer in one command
  (the manual path is `XPENDING range` to list ids, then `XCLAIM key group me minIdle id...`).
- Process the reclaimed entry; ack on success.
- On failure, read that entry's `deliveriesCounter` from `XPENDING`; once it reaches the cap,
  write it to `orders:dlq` with the error and ack it so it stops being reclaimed forever.
- Below the cap, leave it pending - the next reclaim pass retries it after the idle timeout.

**Code:**

```ts
import { redis } from "../lib/redis";

const STREAM = "orders";
const GROUP = "billing";
const ME = process.env.CONSUMER_NAME ?? "worker-1";
const DLQ = "orders:dlq";
const MIN_IDLE_MS = 30_000; // "stuck" = nothing delivered for 30s
const MAX_DELIVERIES = 5; // give up after 5 attempts

export async function pendingSummary() {
  return redis.xPending(STREAM, GROUP); // { pending, firstId, lastId, consumers }
}

export async function reclaimStuck(count = 25): Promise<number> {
  // XAUTOCLAIM = find idle >= MIN_IDLE_MS and hand the entries to me (Redis 6.2+)
  const { messages } = await redis.xAutoClaim(STREAM, GROUP, ME, MIN_IDLE_MS, "0", { COUNT: count });
  let handled = 0;
  for (const msg of messages) {
    if (msg === null) continue; // entry was trimmed out of the stream meanwhile
    await handleWithRetry(msg);
    handled++;
  }
  return handled;
}

async function handleWithRetry(msg: { id: string; message: Record<string, string> }): Promise<void> {
  try {
    await creditInvoice(msg.message);
    await redis.xAck(STREAM, GROUP, msg.id);
  } catch (err) {
    const [entry] = await redis.xPendingRange(STREAM, GROUP, msg.id, msg.id, 1);
    const deliveries = entry?.deliveriesCounter ?? 1; // XPENDING range: per-message attempts
    if (deliveries >= MAX_DELIVERIES) {
      await redis.xAdd(DLQ, "*", { ...msg.message, failedId: msg.id, error: String(err) });
      await redis.xAck(STREAM, GROUP, msg.id); // retire it: stops future reclaim passes
    }
    // under the cap: leave it in the PEL - reclaimStuck() retries it after MIN_IDLE_MS
  }
}

async function creditInvoice(message: Record<string, string>): Promise<void> {
  const orderId = message.orderId ?? "";
  if (orderId === "") throw new Error("malformed entry: missing orderId");
  console.log(`billing: invoice for order ${orderId}`); // real code: idempotent DB write
}
```

**Explanation:** When a worker dies, its delivered entries stay in the PEL - they are neither
new (`>` will not hand them out) nor gone. `XAUTOCLAIM` is the recovery hammer: it walks the
PEL for entries idle past `minIdleMs`, stamps a new delivery time, increments the delivery
counter and transfers ownership to this consumer. The manual equivalent is `XPENDING
start end COUNT` to list candidate ids followed by `XCLAIM key group consumer minIdle id1 id2`,
which is still worth knowing because `XCLAIM` can also adjust `RETRYCOUNT`/`IDLE` explicitly.
The `deliveriesCounter` from `XPENDING` is the retry budget: past `MAX_DELIVERIES` the entry
is almost certainly poison (a malformed payload that will never parse), so we copy it to
`orders:dlq` for a human to inspect and ack the original - acking matters, otherwise every
future reclaim pass keeps dragging it back. This yields at-least-once delivery plus a bounded
retry policy, which is the contract interviewers want to hear.

**Complexity:** `XAUTOCLAIM` is O(1) with a small `COUNT` (it scans the PEL incrementally);
`XPENDING` with a range is O(N) in entries returned; `XACK` and `XADD` to the DLQ are O(1).
Each reclaim pass is a handful of round trips; keep `COUNT` small so one bad stream cannot
make the loop monopolize the server.

**Interview follow-ups:**
- **Q: XCLAIM vs XAUTOCLAIM?** A: `XCLAIM` needs explicit ids (you got them from `XPENDING`);
  `XAUTOCLAIM` discovers and claims in one command (Redis 6.2+) but only hands you entries
  idle past `minIdleTime`.
- **Q: How do you know a message was retried, not just re-read?** A: The PEL's
  `deliveriesCounter` (via `XPENDING`) and `XCLAIM`'s `RETRYCOUNT` option both track it.
- **Q: Why ack after moving to the DLQ?** A: If you do not, the entry stays pending and every
  reclaim pass redelivers it forever - the DLQ copy is the durable record, the ack retires it.
- **Q: Crash *after* processing but *before* XACK?** A: The message is redelivered later, so
  the handler must be idempotent - dedupe on `orderId` or a unique DB constraint.

---

## Exercise 9 - Leaderboard with sorted sets

**Problem:** Build a weekly leaderboard: add points for a player, read the top 10 with
scores, and report a player's 1-based rank from the top.

**Expected solution:**
- `ZINCRBY leaderboard points player` - atomic score increment (also creates the member).
- Top-10 descending: `ZRANGE leaderboard 0 9 REV WITHSCORES` (classic name:
  `ZREVRANGE ... WITHSCORES`) - O(log N + 10), never a full sort in app code.
- Rank from the top: `ZRANK` gives the *ascending* index (0 = lowest score), so convert with
  `ZCARD - rank` for a 1-based "best player = 1" answer; `null` means unranked.
- Rotate or expire the whole key per week (`leaderboard:2026-W41`) instead of deleting
  members one by one.

**Code:**

```ts
import { redis } from "../lib/redis";

const BOARD = "leaderboard:weekly";

export async function recordScore(player: string, points: number): Promise<number> {
  return redis.zIncrBy(BOARD, points, player); // atomic; returns the new score
}

export async function ensurePlayer(player: string): Promise<void> {
  await redis.zAdd(BOARD, [{ value: player, score: 0 }], { NX: true }); // only if absent
}

export async function topPlayers(n = 10): Promise<{ value: string; score: number }[]> {
  // equivalent to: ZREVRANGE leaderboard 0 9 WITHSCORES
  return redis.zRangeWithScores(BOARD, 0, n - 1, { REV: true });
}

export async function rankOf(player: string): Promise<number | null> {
  const ascending = await redis.zRank(BOARD, player); // 0 = lowest score in the board
  if (ascending === null) return null;
  const total = await redis.zCard(BOARD); // O(1)
  return total - ascending; // 1-based from the top: best player -> 1
}

export async function expireBoardNextWeek(): Promise<void> {
  await redis.expire(BOARD, 7 * 24 * 3600); // or just use a date-stamped key
}
```

**Explanation:** A sorted set is a skiplist plus a hash table: by member is O(1) (`ZSCORE`),
by rank/score is O(log N + M), so both "add 20 points for alice" and "give me the top 10"
are cheap even at millions of members. `ZINCRBY` is the update primitive because it is a
single atomic command - two app servers awarding points concurrently cannot lose an update,
whereas read-modify-write in Node would. The descending top-N is the same `ZRANGE` with
`REV: true` (Redis 6.2+); older client APIs exposed it as `zRevRange`, so recognise both
spellings in interview answers. Rank needs care: `ZRANK` walks from the *bottom*, so for a
"who is #1" leaderboard you either invert it (`ZCARD - rank`) or use `ZRANK ... REV` on
servers/clients that support it. Equal scores are ordered lexicographically by member, so
ties still get deterministic, distinct ranks.

**Complexity:** `ZINCRBY`/`ZADD` O(log N), `ZRANGE 0 9 REV` O(log N + M) with M = 10 (so
effectively O(log N)), `ZRANK` O(log N), `ZSCORE`/`ZCARD` O(1); 1 round trip each, 2 for
`rankOf`. Space: O(N) members plus skiplist pointers - the real limit is memory, not time.

**Interview follow-ups:**
- **Q: Does top-10 get slower as the board grows to 10M players?** A: Barely - it is
  O(log N + 10): ~24 skiplist levels vs 10 rows returned; the answer is the 10 returned rows.
- **Q: How would you show "your rank" plus the 10 players around you?** A: `ZRANK` for the
  position, then `ZRANGE key rank-5 rank+4 REV`; or keep a separate capped board for
  competitive tiers.
- **Q: Two players on the same score - what rank do they get?** A: Distinct ranks: equal
  scores are ordered lexicographically by member name, so the tiebreak is deterministic.
- **Q: Weekly boards - how do you clear last week's data?** A: Do not `ZREM` 10M members -
  use a date-stamped key (`leaderboard:2026-W41`) and let the key's TTL (or one `DEL`)
  reclaim it.
- **Q: Sorted set vs SQL `ORDER BY`?** A: Redis pre-pays the ordering at write time
  (O(log N) insert) so reads are O(log N + M) with no sort; SQL re-sorts per query and is
  fine for small tables or complex filters.

---

## Exercise 10 - Atomic counter with INCR / DECR

**Problem:** Implement a counter that stays correct when many Node servers hit the same
Redis: show why read-modify-write in the app loses updates, use `INCR`/`DECR`, and add an
optional `EXPIRE` to make a windowed counter that cleans up after itself.

**Expected solution:**
- Never `GET` -> modify -> `SET` in application code: two servers can interleave and both
  write the same value (lost update).
- Use `INCR` / `DECR`: one command executed atomically by Redis's single thread; the key is
  created as `1` on first `INCR` and must hold an integer value.
- Windowed counters embed the window in the key and `EXPIRE` on first hit, exactly like the
  rate limiter - old windows age out automatically.
- For bounded values (inventory slots that must not go below zero) add a guard, e.g. a Lua
  script, because plain `DECR` happily goes negative.

**Code:**

```ts
import { redis } from "../lib/redis";

// WRONG: read-modify-write across two servers loses updates.
export async function racyIncrement(name: string): Promise<number> {
  const current = Number((await redis.get(name)) ?? 0); // server A reads 5
  await redis.set(name, current + 1); // server B also read 5 -> both write 6, one update lost
  return current + 1;
}

// RIGHT: the read and the write happen inside one atomic Redis command.
export async function nextSequence(name: string): Promise<number> {
  return redis.incr(`seq:${name}`); // creates the key at 1, returns the new value
}

export async function releaseSlot(name: string): Promise<number> {
  return redis.decr(`slots:${name}`); // symmetric with INCR, also atomic
}

export async function hitsInWindow(name: string, windowSec = 60): Promise<number> {
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const key = `hits:${name}:${slot}`; // window id lives in the key -> self-cleaning
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec); // first hit starts the clock
  return count;
}
```

**Explanation:** The broken function is the one people actually write: `GET`, add one in
Node, `SET`. With a single server it works; with two it silently loses increments whenever
their read/write pairs interleave - and the bug disappears in dev, where you run one
instance. `INCR` fixes it structurally rather than with locking: Redis executes commands one
at a time, so the increment cannot be interleaved, and it returns the new value in the same
round trip (also giving you a unique, monotonic id for free). The windowed variant is the
fixed-window rate limiter from Exercise 3 in miniature: the key name carries the window, the
TTL guarantees cleanup, and there is no janitor job. The subtle failure mode to mention is
the `EXPIRE` gap (crash between `INCR` and `EXPIRE` leaves a key that never expires) - same
fix as Exercise 3, one Lua script.

**Complexity:** `INCR`/`DECR`/`EXPIRE` are all O(1), 1 round trip each (Lua collapses the
pair to 1). Space: one small key per name per window, reclaimed by TTL. Contrast with the
racy version: 2 round trips *and* wrong results.

**Interview follow-ups:**
- **Q: What does INCR do if the key does not exist, or holds `"abc"`?** A: Missing key is
  created with value `1`; a non-integer value returns an error (`value is not an integer`),
  which is why counters must never share a key with a string.
- **Q: Can two clients get the same number back?** A: No - command execution is serialized
  on the server, so each `INCR` observes the previous one; that is also why `INCR` doubles
  as a global unique-id generator.
- **Q: How would you make `DECR` refuse to go below zero?** A: Plain `DECR` does not - wrap
  check-and-decrement in Lua, or use a pipeline/`WATCH`, though Lua is the simpler answer.
- **Q: Redis is atomic - is the count safe across a failover?** A: Atomic, not necessarily
  durable: with default async persistence a failover can lose the last writes, so pick the
  durability (`appendfsync`, replica `WAIT`) your counter actually needs.
- **Q: Millions of increments per second on one key - any problem?** A: The *key* is not a
  bottleneck for O(1) commands, but it is a hot key: scale reads from replicas and consider
  sharded counters (`counter:shard3:hits`) merged at read time.
