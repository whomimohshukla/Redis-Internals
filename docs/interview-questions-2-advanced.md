# Redis Interview Questions — Advanced (Q51–Q80)

This file is part of the Redis + caching interview-prep track. Read each question top-down: start with the **Thought process** to understand how an interviewer wants you to reason, use the **Short interview answer** for a crisp spoken response, then dive into the **Deep explanation** for mechanics, numbers, diagrams, and runnable snippets. Finally, scan the **Common mistake** to avoid traps. Treat numbers and examples as mental models (tweak to your system constraints) and map ideas to the tiny examples in `src/` when practicing.

## Advanced (Q51–Q80)

### Q51. Explain cache-aside in depth — its advantages, disadvantages, when to use it, and how invalidation + stampede concerns shape its behavior.

**Thought process:** 
Think in terms of read/write control flow and ownership: cache-aside means the cache is a read-through convenience, not the source of truth. The application controls population and eviction on reads; on writes, it updates the DB and explicitly invalidates or updates the cache. Focus on race windows, consistency tradeoffs, and the "cache miss storm" (stampede) when many readers miss simultaneously.

**Short interview answer:** 
Cache-aside (lazy loading) reads from cache first, falls back to DB on miss and populates cache, and on writes updates DB first (or carefully) then invalidates/deals with cache. Its main advantages are simplicity, resilience if cache goes down (reads still hit DB), and low write amplification. Disadvantages include cold-start misses and potential staleness/race windows between DB write and cache invalidation. Use it when reads dominate, cache is optional, and you need to bound complexity; pair with TTLs, jitter, and coalescing to mitigate stampedes and thundering herds.

**Deep explanation:** 
Cache-aside (also called "lazy loading") is the most common pattern for read-heavy workloads. Its contracts:

- **Read path:** `GET(key)` from Redis. If `HIT` → return. If `MISS` → read from authoritative DB → `SETEX(key, ttl, value)` (or `SET` + `EXPIRE`) → return. This makes cache a performance layer, not a system of record.
- **Write path:** write to DB (`UPDATE/INSERT/DELETE`) first, then invalidate cache (`DEL key`) or (less common) update it (`SET key=value EX`). There is an unavoidable race: readers may populate old data between write and invalidation, and some invalidations can be lost if not idempotent in effect; versioning helps.

**ASCII diagram (read + write):**
```
Read (hit):        Client -> Redis (GET k)=HIT -> Client
Read (miss):       Client -> Redis (MISS) -> DB (SELECT) -> Redis (SETEX k ttl v) -> Client
Write:             Client -> DB (WRITE) --(txn/commit)--> (async/inline) Redis (DEL k)
```

**Numbers to reason with:** 
Suppose 1M QPS read-only, 99% hit ratio → 10k misses/s all hitting DB (potentially). If TTL expires for a hot key, 10k+ concurrent requests can all miss at once ("stampede") unless you coalesce. With cache-aside, adding a cache buys headroom but doesn't eliminate peak-on-expiry or cold start.

**Practical safeguards:**
- **TTL + jitter:** add random 0-20% jitter to TTLs (e.g. `ttl = base + rand(0, base*0.2)`) to avoid synchronized expiries across keys/instances.
- **Request coalescing/singleflight:** when a key is missing, let exactly one in-flight fetch populate cache and share result with waiters (in-process or cross-process via lock+pub/sub). 
- **Stale-while-revalidate (SWR):** serve a slightly stale cached value while refreshing in background (needs versioned keys or "refresh at" timestamps). 
- **Background refresh before expiry:** for very hot keys, refresh proactively when `TTL < threshold` to avoid misses.
- **Negative caching:** cache "not found" with short TTL (e.g. 30s) to blunt cache penetration (see Q58), but be careful with invalidation.

**TypeScript sketch (cache-aside with simple singleflight idea):**
```ts
const inflight = new Map<string, Promise<any>>();
async function get(key: string, fetchDB: ()=>Promise<any>, ttl=60){
  const c = await redis.get(key); if(c) return JSON.parse(c);
  let p = inflight.get(key);
  if(!p){ p = (async()=>{ const v=await fetchDB(); await redis.setEx(key,ttl,JSON.stringify(v)); return v; })().finally(()=>inflight.delete(key)); inflight.set(key,p); }
  return p;
}
async function write(key:string, writeDB:()=>Promise<any>){ await writeDB(); await redis.del(key); } // DB-first + DEL
```

**When to prefer cache-aside:** read-heavy, cache non-critical (can be rebuilt), large keyspace, or when writes are infrequent relative to reads. Avoid if you need strict read-after-write consistency across many keys with zero staleness windows — consider write-through + invalidation with versioning or read-through patterns instead.

**Common mistake:** 
Saying "update cache on write" is always safe — without version checks and careful ordering it creates lost updates/races; the standard safe default is DB-first + DEL with TTLs + stampede controls, not unconditional cache updates. 

---
### Q52. How do you choose a cache TTL strategy? Explain short vs long TTLs and why TTL doesn't guarantee immediate consistency.

**Thought process:** 
TTL is a decay mechanism, not a synchronization primitive. Choosing TTL means trading staleness window against cache hit ratio, backend load, and blast radius. Consider data volatility (how often source changes), read cost, business tolerance for staleness (seconds vs minutes), and expiry clustering.

**Short interview answer:** 
Choose TTL based on volatility and freshness requirements: short TTLs (seconds–minutes) reduce staleness but increase miss rate and DB load; long TTLs (hours–days) improve hit ratio but widen staleness windows on source changes. Never rely on TTL for "immediate" consistency — between updates and expiry, cached values remain stale; use explicit invalidation (DEL/versioned keys), outbox events, or write-through to tighten consistency. Also add jitter to avoid synchronized expiries.

**Deep explanation:** 
TTL bounds how long a value can live regardless of updates. Key points:

- **Volatility-based:** if data changes every few seconds (e.g. counters, live inventory) → short TTL (5–60s); if slowly changing (catalog, configs) → longer (10m–24h). 
- **Cost-based:** expensive reads (multi-table joins, external API) justify longer TTLs; cheap reads may tolerate shorter TTLs.
- **Blast-radius:** longer TTL means a bad write propagates farther; shorter TTL means faster correction but more backend pressure on expiry.
- **Explicit beats implicit:** when you know data changed, `DEL` immediately (Q53–Q54) — TTL is a safety net, not a trigger tied to source mutation.

**Numbers:** 
If you want p99 freshness < 30s, TTL<=30s is necessary but not sufficient (cache may still serve value until expiry/DEL). With 1M QPS and TTL=60s, keys expire over a rolling 60s window (with jitter) — natural amortization. Without jitter, many keys created together expire together (stampede).

**ASCII (staleness window):**
```
T_write: DB updated (v2)
T_del:   Redis DEL k  (ideally soon after)  -> miss after
T_exp:   Redis expires k via TTL (fallback) -> miss after
Staleness window = max(0, now - T_write) for cached v1 until T_del or T_exp
```

**Commands:** `SET key value EX 120 NX` (set with TTL only if absent), `EXPIRE key 120`, `TTL key`, `PEXPIRE`, `SETEX` (atomic SET+EXPIRE).

**Strategy tips:**
- **Adaptive TTL:** increase TTL on stable keys, decrease on churn (rare in simple caches).
- **Sliding expiration:** reset TTL on access (`GETEX` with `EX/PX`) to keep hot keys alive, but can create "never-expire" hot set if misused and makes invalidation timing harder.
- **Jitter:** `const ttl = base * (1 + Math.random()*0.2)` or pick from range.
- **Versioned keys:** `user:123:v2:profile` + old key invalidation lets you serve new immediately and retire old via TTL.
- **Negative TTL:** `SETNX`/`SET` with short EX for "miss" markers.

**Why TTL != immediate consistency:** Redis has no pub/sub from DB to cache unless you build it; expiry is time-based. A value written at T1 remains in Redis until T2 = T1+TTL or until explicit DEL — so clients reading between T1 and T2 see stale data even if DB is newer. Also replication/failover don't "revoke" TTLs retroactively.

**Common mistake:** 
Treating `EXPIRE 5` as "data is fresh for 5 seconds from source change" — it's "data lives at most 5 more seconds from now". Freshness depends on when it was written/last refreshed, not the EX value alone.

### Q53. Compare delete-cache vs update-cache on writes. What race conditions exist for each?

**Thought process:** 
On write, you can (a) update DB then DEL cache (delete-on-write), or (b) update DB then SET cache (update-on-write), or write-through (write to cache+DB). Focus on which is simpler and which races occur: read-modify-write windows, double-SETs, and the classic "read old -> DB new -> DEL after SET old" etc.

**Short interview answer:** 
DB-first + DEL is usually safer and simpler: cache is a projection, easy to invalidate; avoids cache containing values not yet committed in a confusing way and handles partial failures better. DB-first + SET keeps cache hot but risks writing stale values if reads interleave (or if DB update fails after deciding value). Both have races: with DEL, a reader can miss between write and DEL and repopulate old value; with SET, a slow reader that read old value from DB/cache logic can overwrite new value with old. Prefer DEL + TTL unless read latency after write is critical and you have versioning.

**Deep explanation:** 
Two main post-write strategies:

1. **Delete-on-write (invalidation):** `DB.write()` → commit → `redis.del(key)`. Cache repopulated on next read (cache-aside). 
2. **Update-on-write:** `DB.write()` → commit → `redis.set(key, newValue, {EX:ttl})`. Cache always "current" in shape but you must compute new value (and may need to handle many keys/derived values).

**Race examples (classic):**

- **Race A (DEL):** Writer W updates DB to v2. Reader R1 reads cache → MISS, reads DB → gets v1 (if read before W commit? or replication lag?) or more directly: R1: GET MISS -> SELECT v1; W: UPDATE v2, DEL k; R1: SET k v1 (repopulates stale). Window between W's DEL and R1's SET is the problem. Also R2 can miss after DEL and get v2. 
  ASCII:
  ```
  W: DB(v2) done -> DEL k
  R: GET MISS -> DB(v1, old snapshot/read-modify?) -> SET k v1  (stale)
  ```
  Mitigations: DB-first + small delay? not safe; use versioned read (e.g. SELECT ... FOR UPDATE or versioned value), or read-through with request ID/version; or accept with TTL as bound.

- **Race B (SET):** W updates DB to v2 -> SET k v2. R does read-modify-write based on cached v1: reads v1 from cache/DB at T1, computes delta, writes back as v1+delta later but DB was already v2 — lost update unless DB versioned. Also if W fails after DB commit? SET may happen or not; idempotent retry needed.

**Comparison:**
| Aspect | DB-first + DEL | DB-first + SET |
|---|---|---|
| Simplicity | High (just key) | Med (must serialize value) |
| Cold/warm | Next read pays miss | Always warm |
| Staleness window | Until next read+populate | Minimal after write |
| Race risk | "Read old -> SET old after DEL" | "Stale read -> overwrite new" (lost update) |
| Handles derived keys | Easy to DEL many | Must know all derived projections |
| If cache down | Reads still work (aside) | Still works but SET may fail |
| Bandwidth | Less on writes if infrequent reads | More writes to Redis |

**TypeScript (DB-first + DEL with versioning note):**
```ts
async function updateUser(id:string, patch:any){
  const v = await db.updateUser(id, patch); // returns new version
  await redis.del(`user:${id}:v${v- ?}`); // better: del current key; or key includes version
  // simpler: await redis.del(`user:${id}`);
}
```
(Versioned keys: write to `user:123:v2`, update pointers, let v1 expire.)

**Common mistake:** 
Assuming SET-after-write "fixes" consistency — it can introduce lost updates unless you version both DB row and cache key or use CAS (Redis `WATCH` + `MULTI/EXEC` around read-modify-write against Redis values is limited and doesn't coordinate with DB). Prefer DEL as the default; use SET only when you must avoid read misses after write and can enforce ordering/versioning.

### Q54. Beyond DEL, what cache invalidation strategies exist (TTL, write-through, outbox/event-driven, versioned keys)? When to use each?

**Thought process:** 
Invalidation is the hard part. Strategies differ by coupling (sync/async), consistency, and blast radius. Think source-of-truth propagation: push vs pull, eager vs lazy.

**Short interview answer:** 
Key strategies: (1) **TTL-based** (pull): implicit expiry, bounds staleness, scales well but slow to reflect changes. (2) **Explicit DEL** (push-on-write via app): immediate for that key, simple, race-prone without ordering. (3) **Write-through**: write to cache and DB in same write path (often sync) — strong consistency but higher write latency and coupling. (4) **Outbox + event-driven**: DB change written to outbox, message published/streamed, consumers invalidate/update cache asynchronously — decouples, enables many projections, improves write latency; eventual consistency. (5) **Versioned keys**: use new key name (e.g. `obj:v2`) and update references (cache-aside + key rotation) or keep old via TTL — avoids "update in place" races and enables safe rollouts.

**Deep explanation:** 
Details:

- **TTL only:** no app invalidation on write. Cheapest, safest against races, but worst freshness. Good for reference data, CDN-like, or when updates rare/unpredictable.
- **DEL on write (app-driven):** synchronous invalidation after DB commit. Low latency reflection for that key. Needs retry/idempotency; cross-service invalidations need messaging.
- **Write-through:** application writes to cache and underlying store together (or cache is write-through to DB). Read hits are guaranteed fresh relative to last write-through; increases write path latency; cache becomes more critical. Often paired with write-behind for batching.
- **Write-behind (write-back):** write to cache, async flush to DB (buffered). High write throughput, tolerant of DB blips, but risk of data loss on cache crash before flush — needs durability (AOF + WAL).
- **Outbox/event-driven invalidation:** change data capture (CDC) or app inserts into outbox table + transaction, relay publishes events (Streams, Kafka) to cache invalidators. Scales to many services/keys, no sync call from writer to Redis (decouples). Introduces eventual consistency and ordering concerns.
- **Versioned keys + pointer:** store value at immutable key (`resource:123:etag:abc123` or version), keep "current" pointer in a small key (`resource:123:current` -> version). Writes create new version+value, update pointer (CAS or versioned), old versions expire via TTL. Readers always follow pointer. Eliminates in-place overwrite races.
- **Cache tags/bulk invalidation:** tag keys (`post:5` tagged `tag:posts`, `tag:user:1`) and on tag change DEL all tagged keys (can use Sets of key names + `UNLINK`/`DEL` in Lua). Careful with large tag sets (use SCAN + UNLINK or maintain reverse index).
- **Negative invalidation:** when deleting entity, also consider related caches.

**ASCII (outbox):**
```
App -> DB: BEGIN; WRITE entity; WRITE outbox(event=entity.updated,id); COMMIT
Relay/CDC -> Streams/Kafka (event)
Cache svc -> Redis: DEL/SET based on event (idempotent by event id)
```

**When to choose:**
| Strategy | Consistency | Latency (write) | Scale | Complexity | Best for |
|---|---|---|---|---|---|
| TTL only | Eventual (time-bound) | Lowest | High | Low | Static/ref data |
| DEL (app) | Near-real-time | Low | Med | Low | Simple CRUD + cache-aside |
| Write-through | Strong (read-after-write) | Higher (sync) | Med | Med | Must avoid misses after write |
| Write-behind | Eventual | Lowest | High | High | Write-heavy, can tolerate loss window? |
| Outbox+events | Eventual | Low (async) | High | High | Multi-service, many projections |
| Versioned keys | Stronger (pointer CAS) | Med | Med | Med | High contention, zero-downtime |
| Tags | Bulk eventual | Med | Med | Med-High | List/search views |

**Redis commands:** `DEL`, `UNLINK` (async, non-blocking for large values), `EXPIRE`, `PEXPIRE`, `TTL`.

**Common mistake:** 
Using only TTL and thinking "it'll be fine" — for critical updates (price, inventory) you need explicit invalidation; conversely, using only sync DEL across services without retries creates inconsistency on failures. Pick a combination (e.g. DEL + TTL + jitter) rather than a single silver bullet.

### Q55. DB updated but Redis not invalidated — how eventual staleness happens and how to bound it.

**Thought process:** 
Staleness is the state where cache serves v1 after DB is v2. This occurs when invalidation path fails or is skipped. Focus on failure modes (process crash after commit before DEL, network error to Redis, Redis down, outbox relay lag) and bounding via TTL, versioning, and reconciliation.

**Short interview answer:** 
If DB is updated but Redis invalidation never happens (app crash between commit and DEL, Redis unreachable, invalidation event dropped, or logic bug), clients continue to read stale values from cache until they expire. To bound it: enforce TTL on all cached entries (safety net), use idempotent outbox + retries for async invalidation, employ versioned keys/pointers so new reads don't hit stale keys, monitor staleness windows (age of cache), and use negative tests/health checks. Never assume sync invalidation is guaranteed on failures.

**Deep explanation:** 
Staleness window W = time from DB commit (v2) until cache reflects v2 (DEL+repopulate or SET). If invalidation is dropped, W becomes unbounded in theory unless TTL exists.

**Failure scenarios:**
- **Crash-after-commit:** writer process dies after `db.commit()` but before `redis.del()` — cache still has v1.
- **Redis unavailable:** `DEL` throws; if not retried with backpressure/idempotency, stale persists.
- **Network partition:** call to Redis times out (unknown success/fail) — cannot tell if key was deleted.
- **Replication lag / read-modify:** reader repopulates v1 after DEL (Q53).
- **Async event loss:** outbox relay crashes, event not processed, consumers never invalidate.
- **Cross-service:** service A updates DB, calls service B to invalidate — B down or request lost.

**Bounding techniques:**
- **Mandatory TTL:** set `EX`/`PEX` on every `SET` (including negative cache). Pick max acceptable staleness S_max → TTL <= S_max for critical data (or use shorter with proactive refresh).
- **Jittered TTLs:** avoid synchronized expiry but still bound max.
- **Versioned keys:** readers go to `current` pointer; writing creates new versioned value and updates pointer atomically in DB/cache (CAS) — stale version keys ignored. Old versions expire.
- **Outbox + at-least-once + idempotent consumers:** store event id, process once; on failure retry with DLQ and replay.
- **Read-through with validation:** include ETag/version in cached value and validate against DB on critical reads (expensive) or use conditional GETs.
- **Cache age header/metadata:** store `cached_at`/`version` in value to detect "too old" and revalidate (SWR with staleness threshold).
- **Reconciliation jobs:** periodic scans (e.g. every 5m) to compare cache versions vs DB for high-value entities (detect drift).
- **Health/alerts:** alert on high staleness, or on cache hit ratio anomalies after writes.

**Example numbers:** inventory changes must be reflected within 10s for checkout → TTL<=10s + explicit DEL + alerts on replication lag. Catalog changes tolerate 5m.

**TypeScript (bounding with cached_at):**
```ts
type Cached<T>={v:T,ver:number,at:number,ttl:number};
async function getOrLoad(k:string,f:()=>Promise<{v:any,ver:number}>){
  const s=await redis.get(k); if(s){ const c=JSON.parse(s) as Cached<any>; if(Date.now()-c.at < c.ttl*800) return c.v; /* treat as soft-stale */ }
  const {v,ver}=await f(); const c:Cached<any>={v,ver,at:Date.now(),ttl:60}; await redis.setEx(k,120,JSON.stringify(c)); return v;
}
```
(soft-stale + background refresh optional.)

**Common mistake:** 
Believing "sync DEL means zero staleness" — process crashes and network timeouts break this assumption. Always treat cache-aside as eventually consistent and bound with TTL; for strict consistency, redesign read/write paths.

### Q56. Redis updated but DB write failed — consistency pitfalls.

**Thought process:** 
The opposite failure: you write to Redis (SET/DEL) before or instead of a successful DB write, or you SET cache optimistically after a DB write that then fails/rolls back. Cache must not become more "truthful" than the DB.

**Short interview answer:** 
If you update Redis before DB commit succeeds, a subsequent read can return the cached value even though DB has no such committed state (inconsistent view). If DB write fails after you already SET cache to new value, cache is stale relative to DB. To avoid this: never SET cache before DB write commits; for DB-first + DEL/SET, only touch Redis after successful DB commit/transaction; on DB failure, do not write to cache (or explicitly restore); use idempotent retries and avoid write-through that puts cache ahead of source. Also consider compensating actions carefully.

**Deep explanation:** 
Dangerous orderings:

- **Cache-first write (write-around/cache-aside variant):** `redis.set(k,v_new)` → try `db.write()` → if fails, `redis.del(k)` or rollback — but concurrent reads may have already served v_new from cache; also rollback of cache is non-transactional with DB. 
- **DB write fails after cache SET:** e.g. `await db.update(); await redis.set(k,v_new);` but second throws or DB rolled back — cache has v_new, DB has v_old.
- **Partial multi-step:** updating related keys in Redis before all DB writes committed.

**Pitfalls:**
- **Read-modify-write amplification:** clients reading "new" value from cache act on it, producing side effects that contradict DB state.
- **Stuck optimistic state:** if cache SET succeeded but DB failed and process dies, no compensating cleanup occurs.
- **Cross-shard/transactions:** DB transaction may abort after cache write started.
- **Thundering herd on "bad" state:** cached bad value (from failed write) lives until TTL/DEL.

**Safe patterns:**
- **DB-first:** only after `db.commit()` (or successful write) call `redis.del(k)` or `redis.set(k, computedFromDB, ex)`. If Redis call fails after commit, rely on TTL + retry (outbox) rather than trying to "undo" DB.
- **Transaction boundaries:** treat Redis updates as best-effort cache maintenance, not part of DB ACID. Never couple them inside DB transaction.
- **Idempotent + retry with backoff:** for post-commit cache ops, use outbox or background worker to retry on failure.
- **Versioned values:** include version from DB (e.g. updated_at/version) in cache; on reads detect mismatches? not directly.
- **Write-through only if cache+DB can be coordinated** — rare outside same store; avoid updating cache before durable commit.
- **Avoid "read from cache to decide write" then writing cache first:** increases window.

**TypeScript sketch:**
```ts
async function safeUpdate(k:string, patch:any){
  try{
    const newRow = await db.update(patch); // commits inside
    // best-effort after commit
    await redis.del(k).catch(e=>queueRetry(k,'DEL'));
    return newRow;
  }catch(e){
    // DB failed — do NOT touch Redis
    throw e;
  }
}
```

**Example numbers:** in a 10k RPS write path, post-commit Redis failures happen (timeouts) — better to have 1 retry worker than to block write on Redis.

**Common mistake:** 
"Write to cache first for speed" — speed gain is usually negligible and consistency cost is high; cache-first is almost never correct when DB is source of truth. If you must, you need distributed transaction-like coordination (impossible with vanilla Redis+DB alone).

### Q57. Stampede prevention in depth: TTL jitter, distributed lock, request coalescing/singleflight, background refresh, stale-while-revalidate.

**Thought process:** 
Cache stampede (thundering herd on expiry/miss) occurs when many concurrent requests see MISS simultaneously and all hit DB. Prevention is about collapsing concurrent fetches and smoothing expiries. Consider in-process vs cross-process (multiple app instances).

**Short interview answer:** 
Stampede prevention techniques: (1) **TTL jitter** randomizes expiry times to avoid synchronized misses across keys. (2) **Distributed lock (Redis-based)** — when miss, acquire lock (`SETNX EX` with TTL), only lock holder fetches DB and populates cache, others wait/retry or return stale. (3) **Request coalescing/singleflight** — in-process sharing of in-flight fetch promise; cross-process needs lock/pub-sub. (4) **Background refresh** — before TTL expires (e.g. at 80% of TTL), refresh cache in background (proactive) to keep value fresh. (5) **Stale-while-revalidate (SWR)** — if cache is present but "stale" (age>threshold), serve stale immediately and refresh asynchronously. Combine these based on criticality and scale.

**Deep explanation:** 
Mechanics:

- **TTL jitter:** `ttl = base * (0.8 + Math.random()*0.4)` or clamp. Prevents global expiry storms (e.g. all sessions created at hour boundary). Simple, cheap.
- **Distributed lock:** use `SET key:lock value EX 5 NX` to acquire. Lock holder: load from DB, `SETEX` cached value (with its own TTL), then `DEL` lock. Waiters: poll (backoff) or subscribe. Need to handle lock expiry while holder still fetching (fencing token + value TTL > lock TTL? or avoid long DB queries under lock). Also use `UNLINK`/`DEL` carefully.
- **Singleflight (in-process):** map key → Promise; first caller sets promise, others `await` same promise. Collapses threads in one process; no cross-process effect.
- **Cross-process coalescing:** combine lock + pub/sub: on miss, try lock; if fail, subscribe to channel `cache:refreshed:{key}`, wait for message or timeout, then read cache. Lock holder publishes on success/failure.
- **Background refresh:** track `cached_at` + `ttl`. When `now - cached_at > ttl*0.8`, spawn async refresh (fire-and-forget) if not already refreshing (use lock). Readers continue to get current (possibly soon-to-expire) value — avoids miss latency and herd.
- **SWR:** define `stale_after`, `revalidate_after`. Serve from cache if `age < revalidate_after` (fresh) or `stale_after < age < revalidate_after+?` (stale) while kicking off refresh; if `age > max_stale`, treat as miss. Requires cache metadata.
- **Negative caching + jitter:** for "not found", cache with short jittered TTL.
- **Circuit breaker + fallback:** on DB overload, serve stale (if allowed) or degrade.

**Redis commands for locking:** `SET lock:{k} uuid EX 3 NX` (atomic), check value on DEL with Lua: `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end` (avoid deleting other's lock). Also consider Redlock tradeoffs (Q78).

**ASCII (lock-based coalescing):**
```
R1,R2,R3 miss k
R1: SET lock:k id EX 5 NX -> OK (holder)
R2,R3: SET fails -> wait (poll or SUB)
R1: DB fetch v -> SETEX k 60 v -> PUBLISH cache:k:done v -> DEL lock:k
R2,R3: GET k -> HIT (or get on msg) -> return
```

**TypeScript (singleflight + lock sketch conceptually):**
```ts
const sf = new Map<string,Promise<any>>();
async function getCoalesced(k:string, load:()=>Promise<any>, ttl=60){
  const c=await redis.get(k); if(c) return JSON.parse(c);
  let p=sf.get(k); if(!p){
    p=(async()=>{
      const lk=`lock:${k}`, id=uuid();
      const ok=await redis.set(lk,id,'EX',5,'NX');
      if(ok){
        try{ const v=await load(); await redis.setEx(k,ttl,JSON.stringify(v)); return v; }
        finally{ await redis.eval(delIfMatch,1,lk,id); }
      }else{
        // wait briefly and retry read
        await sleep(10); const c2=await redis.get(k); if(c2) return JSON.parse(c2);
        // fallback to load or throw
        return load();
      }
    })().finally(()=>sf.delete(k));
    sf.set(k,p);
  }
  return p;
}
const delIfMatch = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;
```

**Numbers:** with 10k concurrent misses on same key expiring, singleflight+lock reduces DB calls to 1 (vs 10k). Background refresh at 80% TTL with 60s base means refresh happens at ~48s, value stays warm.

**Common mistake:** 
Using a fixed TTL without jitter and no coalescing in high-traffic paths — predictable expiry creates regular stampedes. Also deleting lock unconditionally (no token check) causes "lock stealing" when holder is slow (Q78).

### Q58. Bloom filter for cache penetration — false positives vs false negatives, why no false negatives, when useful.

**Thought process:** 
Cache penetration = many requests for keys that don't exist in DB (and often never will), causing cache misses + DB hits for every request. Bloom filter is a space-efficient probabilistic set: can answer "possibly in set" or "definitely not in set". Key: it has false positives but no false negatives (if it says "not in", answer is certain).

**Short interview answer:** 
Use a Bloom filter in front of cache/DB to reject "definitely missing" keys without querying DB. A Bloom filter uses k hash functions over m bits: false positive = says "maybe exists" but actually doesn't (causes unnecessary DB lookup); false negative = says "definitely not" but actually exists (would incorrectly reject valid key) — Bloom filters do NOT have false negatives by construction (bits only set, never cleared). This makes them safe to block non-existent keys. They're useful when penetration is high (bots, invalid ids), keyspace is large, and you can tolerate small FP rate; less useful if set changes frequently (unless using Counting Bloom filters).

**Deep explanation:** 
How it works:
- Empty: all bits 0. Insert key x: compute h1(x)..hk(x) → set those bits to 1.
- Query y: check bits h1(y)..hk(y); if any is 0 → definitely not in set. If all 1 → possibly in set (could be collision = FP).
- No false negatives because once a bit is set, it's never cleared; to say "definitely not" requires some bit to remain 0, which means we never inserted any key that set it.

**Probabilistic math intuition (order of magnitude):**
- m bits, n elements, k hashes: optimal k ~ (m/n)*ln2, FP probability ~ (1-e^(-kn/m))^k <= (1/2)^k. Example: n=10^6, m=10^7 bits (~1.25MB), k=7 → FP ~ 0.8%. Tuning trades space vs FP.
- Cannot remove elements without risking false negatives (deletions clear bits that other elements still need) → use Counting Bloom filter (counters) or Cuckoo filter if deletes needed.

**Integration patterns:**
1. On DB miss (key doesn't exist), insert key into "non-existent" Bloom filter with TTL or explicit add (and maybe also into negative cache).
2. On read: first query Bloom filter for "exists-in-DB"? Or track known existing keys: maintain BF of keys that have been seen in DB (positive BF). Then: if BF says "no" → return 404 without DB/cache lookup. If BF says "yes" → go to cache-aside (may still miss). 
   Alternatively track negative set: BF of missing keys seen (with refresh on DB creation). Both work.
3. Sync with DB: on entity creation, add to BF (and to cache). On deletion, if using plain BF you can't easily remove — negative-BF-of-misses becomes stale; prefer positive BF of existing keys or use versioned rebuilds.

**Redis options:** modules (Redisson, RedisBloom/BloomFilter module) or client-side BF with Redis to share bitsets (`SETBIT`, `GETBIT`, or string bitfields). For many use cases, client-side per process is fine if size small; shared BF needs coordination.

**ASCII:**
```
Request key K
  -> Bloom filter: has K? 
     NO (some bit 0) => "doesn't exist" -> return 404 (no DB hit)
     YES (all bits 1) => "maybe exists" -> cache-aside: check Redis, else DB
```

**When useful:** high rate of invalid keys (username lookups, short URLs, product IDs that never exist), read-heavy, DB expensive. When not: small keyspace, writes create/delete frequently with strong consistency needs, or FP rate unacceptable.

**Common mistake:** 
Claiming "no false negatives means Bloom filter is perfect" — it means safety (won't block real keys), but false positives still cause DB lookups; also forgetting to update BF on creates/deletes (staleness). Also confusing with caches (BF is not a cache of values, it's a set membership test).

### Q59. Hot key problem in depth — one hash slot/one shard, local cache, key replication, CDN, coalescing.

**Thought process:** 
A "hot key" is a single key with disproportionately high read/write traffic (e.g. celebrity profile, config). In Redis (standalone or Cluster), all ops for that key go to the node/shard holding its hash slot — that single node becomes bottleneck (CPU/network/IO). Solutions reduce load on that node by caching locally, replicating read access, or coalescing requests.

**Short interview answer:** 
Hot keys overload the single shard responsible for them. Mitigations: (1) **Local in-process cache (client-side)** — cache hot key in app memory with short TTL (e.g. 1–5s) to absorb reads without hitting Redis; coordinate invalidation. (2) **Key replication / read replicas per key** — create N copies of the hot value at keys `hotkey#1`, `hotkey#2`, ... distributed to different slots/nodes, and clients round-robin reads (write goes to primary key + updates replicas or uses pub/sub). (3) **CDN/edge caching** for public read-only hot keys. (4) **Request coalescing/singleflight** across clients. (5) **Hash tag splitting carefully**? not directly (tags pin to slot). (6) **Proxy/load shaping** (rate limits per key). Also consider moving computation to clients (e.g. read-only snapshots) or using Redis read replicas (standalone) — in Cluster, replicas serve reads but same slot family.

**Deep explanation:** 
Why shard-bound: Redis Cluster maps key -> slot = CRC16(key) mod 16384, slot -> master node. One key → one slot → one master. Hot shard can occur even without single hot key if many hot keys map to same slot (Q60).

**Techniques:**

- **Local cache (near-read):** in each app instance, keep LRU cache for hot keys with very short TTL/jitter. Reads hit local first (microseconds), Redis hit only on local expiry. Invalidation: on write, publish invalidation event to all app instances (Pub/Sub or Streams) to clear local cache, or just let TTL expire. Tradeoff: cross-instance staleness window until TTL or event.
- **Read-only replicas of the hot key:** write to primary `k`, then `SETEX k_r1 v ttl`, `SETEX k_r2 v ttl` on different nodes (use hash tags? or different key names not sharing tag). Clients pick random replica key for reads. Writes become N writes (costly) but reads scale linearly.
- **Client-side key hashing for reads:** e.g. `readKey = k + '#' + (hash(clientId+ts)/N)` to spread — only useful if value immutable or with versioned reads.
- **Coalesce requests:** singleflight per key across the fleet (lock+pub/sub) so only one Redis read happens even if 1000 clients ask simultaneously.
- **Proxy-side caching:** Redis proxy (e.g. Twemproxy with local cache, Envoy) can cache hot keys.
- **Decompose hot key:** split value into multiple keys (shards of counters) and aggregate on read (e.g. counter split into 10 keys, sum) — good for INCR-heavy hot counters.
- **Backpressure:** per-key rate limiting (Q80) to protect DB/Redis.
- **CDN for static/read-only:** if globally hot and public, offload to CDN.

**ASCII (local cache + Redis):**
```
App instance A: LocalMap[k] maybe stale -> if fresh return; else Redis GET k -> populate local (ttl 2s)
Write path: DB write -> DEL k (and optionally pub invalidation to all instances)
Instances receive invalidation -> clear LocalMap[k]
```

**Numbers:** 1 hot key at 50k RPS read — 1 Redis node core saturated; with local cache TTL 2s and 100 app instances, Redis reads drop to ~50 RPS on that key (amortized) plus invalidation overhead.

**Redis Cluster note:** replicas can serve reads (`READONLY`), but the hot key's slot is still tied to its master+replicas set; spreading reads across replicas helps but master still does writes and all replicas for that slot sync same key. Replication doesn't move the key to different shards.

**Common mistake:** 
Trying to "fix hot key" by adding more Cluster nodes alone — hash slot of that key stays on same node unless you reshard, but resharding moves the whole slot (many keys) and one hot key doesn't justify moving an entire slot unless you split keys. Also overusing hash tags to force placement can create hot slots.

### Q60. Hot shard / capacity imbalance in Redis Cluster and why adding nodes doesn't fix a single hot key.

**Thought process:** 
Hot shard = a Redis node (master) receives much more traffic than others because many keys (or a few very hot) map into its slots. Capacity imbalance is uneven slot distribution or skewed access. Adding nodes gives you more slots total but doesn't automatically relocate a specific hot key's slot unless you reshard; also CRC16 mod 16384 is fixed mapping.

**Short interview answer:** 
In Redis Cluster, 16384 slots are partitioned across masters. A single hot key always hashes to exactly one slot → one master (hot shard if that slot's keyset is hot). Adding nodes increases total capacity but the mapping is slot-based: existing slots stay put unless you explicitly reshard (MIGRATE/RESHARD) some slots to new nodes. You cannot "split" a single key's slot except by key-splitting (creating multiple key names). Also rebalancing moves whole slots, not individual hot keys, so a lone hot key will still live on whichever node owns its slot unless you redesign access patterns.

**Deep explanation:** 
Mechanics:
- Key -> slot: `slot = CRC16(key) & 0x3FFF` (mod 16384). 
- Slots are contiguous ranges per node. Hot key → fixed slot → fixed node.
- Adding a node means it has 0 slots initially; `CLUSTER ADDSLOTS` or reshard moves some slot ranges from existing masters to new node. This spreads total keys/slots but doesn't change which slot a given key maps to.
- If slot S is 100% hot (one key), moving S to new node just moves the bottleneck to new node.

**Imbalance causes:**
- Access skew: popularity distribution heavy-tailed.
- Keyspace skew: uneven number of keys per slot (less common if keys random).
- Poor hash tags: overusing `{...}` pins many related keys to same slot (can create hot slot).

**Mitigations:**
- **Key splitting:** for a hot counter `hits:page:123`, split into `hits:page:123#0`..`hits:page:123#9` (different keys → different slots, with high prob), write to random/sharded, read sum. For values, replicate to read-only keys on different slots (Q59).
- **Local cache + coalescing:** reduces Redis hits regardless of slot location.
- **Resharding hot slots away?** only helps if slot has other cold keys and you want to free capacity, but the hot key itself is still the same slot pressure.
- **Use hash tags judiciously:** don't create artificial hot slots; tags are for multi-key ops that must be in same slot.
- **Read from replicas:** Cluster replicas serve reads (`READONLY`); helps read scaling for that slot but write load and replication network still hit master.
- **Client-side routing awareness:** ensure clients don't create unnecessary MOVED/ASK churn.

**ASCII:**
```
Keys -> CRC16 mod 16384 -> Slots 0..16383 distributed over M1,M2,M3
Hot key K -> Slot 42 -> M1 (100% of K's traffic). 
Add M4, reshard Slot 10-20 to M4: Slot 42 still on M1 → bottleneck unchanged.
Split K into K#0-K#9: map to 9 different slots (likely on different nodes) → traffic spread.
```

**Numbers:** 16384 slots is fixed (designed for ~1000 nodes max, fine). Slot size imbalance < 10% after reshard is typical target; access imbalance can be much larger.

**Common mistake:** 
Saying "just add more Redis nodes in Cluster" fixes a single hot key — without key-splitting or local caching, the key remains on its slot/node. Also confusing "hot slot" (many hot keys same slot) with "hot key" (one key).

### Q61. Eviction policies in depth — maxmemory, noeviction vs allkeys-lru vs allkeys-lfu vs volatile-*, how Redis decides, what happens on noeviction write.

**Thought process:** 
When `maxmemory` is set, Redis must evict keys to make space on writes (and sometimes on certain commands) according to policy. Policies differ by which set (all keys vs keys with TTL/EXPIRE) and by algorithm (LRU, LFU, random, TTL). Understand exact behavior on write when full under noeviction.

**Short interview answer:** 
`maxmemory` limits memory used by Redis (dataset + overhead). Eviction policy (`maxmemory-policy`) determines which keys to remove when memory > maxmemory and new writes need space: `noeviction` returns error on writes that would require allocation; `allkeys-lru` evicts least-recently-used among all keys; `allkeys-lfu` evicts least-frequently-used among all; `volatile-lru/lfu` evict LRU/LFU among keys with `EXPIRE`/`SETEX`; `allkeys-random`, `volatile-random`, `volatile-ttl` (evict shortest TTL first). Redis samples (not scans full set) to approximate LRU/LFU efficiently. Under `noeviction`, `SET`, `INCR`, `HSET`, etc. that add data will fail with `OOM command not allowed when used memory > maxmemory` (read-only ops like `GET` still work).

**Deep explanation:** 
Configuration:
- `maxmemory <bytes>` — 0 means unlimited.
- `maxmemory-policy` — default often `noeviction` in some setups, but depends.
- `maxmemory-samples` — number of keys sampled per eviction (default 5) to approximate; higher = better accuracy, more CPU.

**Policies:**
| Policy | Evicts from | Algorithm | Use case |
|---|---|---|---|
| noeviction | None | N/A | Cache must not lose data; prefer to fail writes (e.g. state store). |
| allkeys-lru | All keys | Least recently used | General cache, hot set changes over time. |
| allkeys-lfu | All keys | Least frequently used | Long-tail access, better for stable popularity. |
| allkeys-random | All keys | Random | Simple, uniform. |
| volatile-lru | Keys with TTL | LRU | Keep persistent keys, evict expiring first. |
| volatile-lfu | Keys with TTL | LFU | Same as above but frequency-based. |
| volatile-random | Keys with TTL | Random | Evict random expiring. |
| volatile-ttl | Keys with TTL | Shortest TTL first | Evict soon-to-expire to make space? or free expiring. |

**How Redis decides:** on write commands that increase memory (or could), if `used_memory > maxmemory`, Redis evicts per policy until `used_memory <= maxmemory - threshold` (or enough space). Sampling: pick `maxmemory-samples` random keys, find best candidate by policy, evict it (`UNLINK` or `DEL`), repeat if needed. This is approximate LRU/LFU (Redis uses approximated LRU with bit + pool, and LFU with logarithmic counters).

**noeviction behavior:** writes that would consume additional memory are rejected. Read commands (`GET`, `LRANGE`, `TTL`, etc.) continue to work. `DEL`/`UNLINK` free space. `EXPIRE`-driven expirations also free memory over time. This is critical: if cache is full and policy is noeviction, app sees write errors (OOM) — must handle retries/backpressure.

**Commands/inspection:** `INFO memory` (used_memory, maxmemory, used_memory_rss, mem_fragmentation_ratio, evicted_keys), `CONFIG GET maxmemory*`, `MEMORY USAGE key`, `MEMORY STATS`.

**Example:** maxmemory=1GB, allkeys-lru, samples=5 — on insert, samples 5 keys, evicts the one least recently accessed among them. With access skew, approximation is usually effective.

**Common mistake:** 
Assuming full LRU scan — Redis samples; assuming noeviction means "never evict" so cache never grows past maxmemory (true) but writes fail. Also confusing volatile-* with allkeys (volatile won't evict non-TTL keys even if "better" candidates).

### Q62. Inspecting Redis memory (INFO memory, used_memory, fragmentation ratio, maxmemory) and capacity planning.

**Thought process:** 
Memory visibility is essential for capacity planning and diagnosing OOM/fragmentation. Key metrics: total used, RSS, fragmentation, max limit, overhead per key. Plan headroom for peak, key growth, replication buffers, and AOF/RDB overhead.

**Short interview answer:** 
Inspect with `INFO memory`: `used_memory` (dataset size in bytes, excluding RSS overheads counted separately), `used_memory_rss` (resident set size), `mem_fragmentation_ratio = used_memory_rss / used_memory` (ideally ~1.0–1.5; >2.0 indicates fragmentation), `maxmemory` (limit if set), `maxmemory_human`, `evicted_keys`, `expired_keys`, `used_memory_peak`. For capacity planning: model key count × average value size + overhead (dict/hash, TTL, pointers) with margin (20–50%), account for replication (each replica holds full dataset), AOF rewrite buffers, client buffers, and peak write bursts. Also monitor `MEMORY USAGE key` per type, and track growth trend (weekly). If fragmentation high, consider restart or `MEMORY PURGE` in some Redis versions (not always available).

**Deep explanation:** 
Key fields:
- `used_memory`: bytes allocated by Redis for data structures (strings, dicts, zsets). Does not include OS page cache except as RSS.
- `used_memory_rss`: OS RSS — memory actually mapped. Includes fragmentation, allocator overhead.
- `mem_fragmentation_ratio`: `used_memory_rss/used_memory`. <1.0 rare (shared memory), 1.0–1.2 good, 1.3–1.5 acceptable, >1.6 often high fragmentation (can be caused by many small allocations/deallocations, jemalloc behavior). 
- `maxmemory`: configured limit (0 = no limit).
- `evicted_keys`: cumulative evictions since start (under maxmemory policy).
- `expired_keys`: keys expired (TTL reached).
- `used_memory_peak`: high-water mark.
- `used_memory_overhead`: Redis internal overhead.
- `allocator_*`: memory allocator stats (jemalloc/tcmalloc).

**Capacity planning steps:**
1. **Baseline:** measure `used_memory` for current dataset (e.g. 10GB). Also per-entity size: `MEMORY USAGE user:123` averaged over sample.
2. **Growth:** project key count growth (e.g. 20%/month). Include new features (caches).
3. **Overhead:** Redis overhead ~ 8–20% depending on types (hashes can be memory-efficient with ziplist in small sizes; sets/sorted sets vary). Factor in.
4. **Replication:** N replicas → total memory = dataset * (1+N) on masters+replicas (each holds full). Also network buffers.
5. **Headroom:** keep 15–30% free below maxmemory to avoid eviction churn (especially with LRU approximation). For latency-sensitive, larger headroom.
6. **Fragmentation margin:** if ratio historically 1.4, budget extra 40% relative to used_memory.
7. **Peak spikes:** consider write bursts creating temp structures, AOF rewrite (needs ~double during rewrite in worst cases? RDB/AOF overhead).
8. **Limits:** OS limits (`ulimit -v`), container memory limits.

**Example calculation:** 100M keys, average string value 256B + key 24B + overhead ~80B → ~36GB raw, +40% margin → ~50GB. With 2 replicas, ~150GB total across cluster nodes.

**Commands:**
```bash
redis-cli INFO memory
redis-cli MEMORY USAGE keyname
redis-cli MEMORY DOCTOR  # diagnostics
redis-cli MEMORY STATS
redis-cli CONFIG GET maxmemory
```

**Notes:** `used_memory` is the "logical" dataset size; RSS is what OS sees. Fragmentation can be reduced by `MEMORY PURGE` (if supported, jemalloc), or by restarts and avoiding churn. In containers, cgroups limit RSS.

**Common mistake:** 
Planning only on `used_memory` without RSS/fragmentation and without replication — can hit container limit even if `used_memory < maxmemory`. Also ignoring `evicted_keys` trend (rising evictions = undersized cache).

### Q63. Hit ratio math — show numerically how 1% of 1M QPS misses still hammer PostgreSQL, what hit ratio to target.

**Thought process:** 
Hit ratio H = cache hits / (hits+misses). Miss rate m=1-H. Each miss typically generates a DB read (and possibly write to cache). At high QPS, even small m creates massive DB load. Target depends on DB capacity, cost, latency SLO.

**Short interview answer:** 
Hit ratio H = (requests served from cache)/(total requests). Misses = total*(1-H). Example: 1M QPS, H=99% → 10k misses/s. If each DB query is 10ms and DB can handle ~100 QPS/core (simplified), 10k misses/s need ~100 cores just for cache misses — unsustainable; H=99.9% → 1k misses/s (10 cores). Target H>=99.9% for hot read paths where DB is expensive, or >=99% for cheap reads. Also consider read-after-write consistency needs. Don't chase 100% (impossible with TTLs/expiries); focus on protecting DB (circuit breakers, coalescing, backpressure).

**Deep explanation:** 
Math:
- Total R=10^6 QPS, H=0.99 → hits 990k, misses 10k/s.
- Each miss = 1 DB query (SELECT). If DB p95 latency 5–20ms, throughput per connection/core limited (e.g. 50–200 QPS simple queries). 10k/s / 100 QPS/core = 100 cores.
- With H=0.999 → 1000 misses/s → 10 cores. With H=0.9999 → 100 misses/s.
- Writes don't count as "read hits" but affect invalidation; also cache-aside means miss path does 2 Redis ops (GET MISS + SETEX) plus DB.
- Stampede on expiry multiplies effective misses temporarily.

**Latency impact:** miss path is DB RTT + cache write; hit is Redis RTT (~1ms vs 5–50ms). User-visible latency dominated by tail on miss path.

**Targeting:**
- **Mission-critical read-heavy:** target >= 99.9% hit ratio (e.g. auth/session lookups).
- **General content:** >=99% often acceptable.
- **Expensive aggregates:** optimize to >=99.5% with longer TTLs + SWR.
- **Write-heavy:** hit ratio lower but DB still needs protection.

**Modeling:** 
```
DB_capacity = min(connections*QPS_per_conn, cores*QPS_per_core)
Required_DB = R*(1-H) * (overhead_factor)
Need H such that Required_DB <= DB_capacity * safety_factor (e.g. 0.7)
```

**Practical tips:** track hit ratio per key pattern (`INFO stats` `keyspace_hits/misses`, or app metrics), set alerts on (1-H) rising, and use coalescing to make miss cost "amortized" even if H dips temporarily.

**Redis metrics:** `redis-cli INFO stats | grep keyspace` gives `keyspace_hits`, `keyspace_misses`, `hit_ratio = hits/(hits+misses)`. Also `expired_keys`, `evicted_keys`.

**Example calc:**
```
hits=9,900,000, misses=100,000 over 10s? Or 990k/s, 10k/s.
If DB max 5000 QPS sustainable → max misses/s=5000 → 1-H <= 0.005 → H>=99.5%.
```

**Common mistake:** 
Saying "99% is good enough" without numbers — at 1M QPS, 1% is 10k/s (a full DB cluster). Also ignoring that cache misses are bursty (stampedes) and that tail latency multiplies impact.

### Q64. Redis transactions: MULTI/EXEC/DISCARD/WATCH, no rollbacks, no isolation guarantees vs PostgreSQL ACID.

**Thought process:** 
Redis transactions are command queuing with optional optimistic locking (`WATCH`). They are atomic in execution (all queued run or none), but differ fundamentally from RDBMS ACID: no rollback on command failure inside EXEC, and no MVCC/isolation across clients except `WATCH`-based optimistic check. Also commands are not "executed" until EXEC.

**Short interview answer:** 
`MULTI` starts transaction, queues commands; `EXEC` executes all queued atomically (no interleaving by other clients); `DISCARD` aborts queue; `WATCH key` provides optimistic locking (if watched key changes before EXEC, EXEC returns nil/aborts). Redis transactions are atomic but not durable/isolated like ACID DBs: if a queued command fails at EXEC time (e.g. wrong type), others may still have executed (no rollback). There is no row-level isolation/MVCC — other clients can read/write keys outside transaction; `WATCH` only prevents EXEC if watched keys were modified. Compared to PostgreSQL: no BEGIN/COMMIT with rollback segment, no serializable isolation guarantees, and commands are simple primitives.

**Deep explanation:** 
Flow:
- `WATCH k1 k2` — set optimistic locks on keys (or use `UNWATCH`).
- `MULTI` — enter transactional context; subsequent commands return `QUEUED`.
- queue commands (SET, HSET, etc., pure operations).
- `EXEC` — check if any watched key was modified since WATCH. If yes → EXEC fails (returns nil), transaction aborted. If no → execute all queued commands sequentially, atomically (no other commands interleaved). 
- `DISCARD` — flush queue and clear watches.

**Key properties:**
- **Atomicity of execution:** all or none run as a batch (EXEC is single operation). But "all or none" means if watched changed, none executed; if executed, all queued execute in order.
- **No rollback on errors:** if a command inside EXEC errors (e.g. `INCR` on string value, type error), Redis does NOT roll back previous successful commands in the same EXEC — they remain applied. This is different from DB transactions.
- **No isolation between transactions/clients except WATCH:** while commands are queued, other clients can modify keys. WATCH detects modifications (by any client) to watched keys between WATCH and EXEC.
- **No durability guarantee in transaction alone:** persistence is via RDB/AOF (Q68–Q69), transaction doesn't fsync.
- **Limited scope:** cannot do read-modify-write across keys unless you WATCH and recheck; also no "SELECT FOR UPDATE".

**Example:**
```bash
WATCH balance:alice
MULTI
DECRBY balance:alice 10
INCRBY balance:bob 10
EXEC
# if balance:alice changed after WATCH -> returns (nil), retry
```
If balance:alice unchanged → both execute atomically. If during EXEC the first command is type error, second may still run (no rollback).

**vs PostgreSQL ACID:**
| Aspect | Redis MULTI/EXEC/WATCH | PostgreSQL |
|---|---|---|
| Atomicity | Execution atomic (batch) but no command-level rollback | Full ACID atomicity (all or none, rollback) |
| Consistency | Application-enforced | Constraints, FK, checks |
| Isolation | Optimistic via WATCH; no MVCC snapshot inside MULTI except reads are queued? (reads in MULTI return QUEUED, values read at EXEC time? no — to read values you must GET before MULTI or use Lua). | MVCC, various levels (READ COMMITTED, REPEATABLE READ, SERIALIZABLE) |
| Durability | Depends on RDB/AOF | WAL + fsync |

**Important:** you cannot read a key's value inside MULTI in the sense of "see state" except by issuing commands; better to read before WATCH/MULTI. For complex read-modify-write, Lua scripts are preferred (atomic, single round trip, no WATCH race window issues in same script).

**Common mistake:** 
Expecting rollback like `BEGIN; ...; ROLLBACK` — in Redis, failed commands in EXEC don't trigger rollback. Also using WATCH as a global lock (it's optimistic, not blocking). 

### Q65. Lua scripts in Redis — atomicity, the INCR+EXPIRE first-request pattern, why separate commands race.

**Thought process:** 
Lua scripting executes server-side as a single atomic operation: no other commands run while script executes. This is the correct way to do multi-command read-modify-write without WATCH races and often fewer round trips. Classic example: set key only if absent with EXPIRE in one go (to avoid key existing without TTL).

**Short interview answer:** 
Lua scripts run atomically on the Redis server — the entire script executes without interruption from other clients (like a "mini transaction" but with logic/branching). This prevents races between separate commands. For example, to ensure a "first request" key has INCR and EXPIRE together: run `INCR key; EXPIRE key 60` as two commands → another client can `GET` between them and see key without TTL, or expiry logic races; in Lua do `local v=redis.call('INCR',KEYS[1]); if v==1 then redis.call('EXPIRE',KEYS[1],60) end; return v`. Also scripts are efficient (reduced RTT), can read/write multiple keys atomically, and use `EVALSHA` for caching.

**Deep explanation:** 
Atomicity: Redis serializes script execution — during `EVAL/EVALSHA`, no other commands are processed. This is stronger than MULTI/EXEC for logic (conditionals, loops, reads+writes). Scripts can access keys via `KEYS[]` and args via `ARGV[]`.

**Race example (INCR+EXPIRE):**
- Separate: Client A: `INCR counter` → returns 1 (key created, no EXPIRE yet). Client B: `GET counter` between A's INCR and EXPIRE → sees 1, key may live forever if A crashes before EXPIRE. Also if key existed before, you want EXPIRE only on creation? pattern depends.
- Lua (atomic):
```lua
-- EVAL "..." 1 counter 60
local key = KEYS[1]
local ttl = ARGV[1]
local v = redis.call('INCR', key)
if v == 1 then
  redis.call('EXPIRE', key, ttl)
end
return v
```
Now INCR+conditional EXPIRE happen together — no window where key exists without TTL on first creation.

**Other patterns:**
- **Distributed lock with refresh/validation:** atomic check+get+set.
- **Rate limiting counters:** read count, check limit, INCR in one script (Q80).
- **Multi-key updates:** update related keys atomically.
- **Read-modify-write with version checks:** compare-and-swap logic.

**Constraints:**
- Scripts must be deterministic in effect? (avoid `TIME`, `SRANDMEMBER` with certain semantics if not careful, and keys must be passed via KEYS for Cluster compatibility).
- Long-running scripts block Redis (single-threaded) — avoid slow loops, large scans.
- `EVALSHA` caches script by SHA1 (use when reusing).
- In Cluster, all keys in script must map to same hash slot (or use hash tags).

**TypeScript example (ioredis):**
```ts
const script = `
local k=KEYS[1]; local t=ARGV[1]; local v=redis.call('INCR',k);
if v==1 then redis.call('EXPIRE',k,t); end; return v;
`;
const v = await redis.eval(script, 1, 'counter', '60');
```

**vs MULTI/EXEC:** Lua can do conditionals and read values at execution time inside script; MULTI queues commands (values read before MULTI or you can't branch). Lua is preferred for complex ops.

**Common mistake:** 
Using separate `INCR` then `EXPIRE` without atomicity — creates "orphan keys" (no TTL) on process crash between commands, or incorrect semantics on first access. Also running very long Lua scripts (blocks everything).

### Q66. Pipelining in depth — round trips saved, throughput vs latency, pipeline ≠ transaction, CPU cost remains.

**Thought process:** 
Pipelining batches multiple commands into one round trip to Redis server. Server queues and executes them in order, returns responses in order. This dramatically improves throughput in high-latency networks (RTT dominates), but doesn't guarantee atomicity across commands except as a batch execution order; it's not MULTI/EXEC. CPU cost per command remains (server still executes each).

**Short interview answer:** 
Pipelining sends multiple commands without waiting for each reply (TCP), reducing RTT count from N to 1. It increases throughput (commands/sec) especially over WAN/high-latency links, and can reduce client-side latency for bulk ops. However, pipeline ≠ transaction: commands are not atomic as a group (other clients can interleave between them, no WATCH), and if one fails, others still execute. Responses come in order. CPU cost per command is unchanged (Redis is single-threaded but executes sequentially). Use for bulk reads/writes (mget/mset variants, many GETs), not as a substitute for atomicity.

**Deep explanation:** 
RTT example: 1ms RTT, 1000 commands. No pipeline: 1000*1ms = 1000ms. Pipelined: ~1–2ms for all + execution time. Savings huge if network-latency bound.

**How it works:**
- Client writes command bytes to socket without reading replies.
- After sending batch, reads all replies in order (RESP).
- Server processes commands sequentially (single-threaded) as received; replies queued in order.

**Throughput vs latency:**
- **Throughput:** higher (more commands per second) due to less network overhead and better socket utilization.
- **Latency (per command):** individual command latency can appear higher if you wait for whole batch, but end-to-end batch latency lower. For interactive single commands, no pipeline needed; for bulk, pipeline wins.
- **CPU:** same work per command; pipelining avoids syscall/context switch overhead of many round trips.

**Pipeline ≠ MULTI/EXEC:**
| Aspect | Pipeline | MULTI/EXEC |
|---|---|---|
| Atomicity | No (interleaved by others) | Execution atomic (batch) |
| Failure handling | Each command's reply returned; no rollback | Atomicity rules as Q64 |
| Purpose | Reduce RTT (performance) | Atomic grouping |
| WATCH support | No | Yes |
| Queuing | Client-side buffer, sent together | Server-side queue |

**Limits:** very large pipelines (10k+ commands) can create large TCP buffers, memory pressure on client/server, and longer "latency tails" if one part slow. Also need to handle backpressure.

**TypeScript (ioredis):**
```ts
const pipeline = redis.pipeline();
for(let i=0;i<1000;i++) pipeline.get(`key:${i}`);
const results = await pipeline.exec();
```

**When to use:** bulk GETs (`MGET` preferred if available, but pipeline also fine), bulk SETs, warmup, data migration scans. Avoid when you need results of command N to decide command N+1 (unless Lua). Also not needed on localhost with tiny RTT.

**Common mistake:** 
Thinking pipeline gives ACID guarantees — it doesn't. Also using pipeline to "lock" keys (no). Another: assuming CPU drops — it often stays same or slightly better due to fewer syscalls.

### Q67. Connection management — connection storms, app servers × connections, pools, persistent connections.

**Thought process:** 
Redis connections are TCP sockets; each client connection has memory overhead (buffers, client struct) and file descriptors. At scale (many app instances, many threads), naive "connect per request" creates connection storms, handshake overhead, and can hit `maxclients`. Use connection pools and persistent/reusable connections.

**Short interview answer:** 
Each Redis client connection consumes memory (~5–10KB overhead plus buffers) and a file descriptor. Problems: (1) **Connection storm** — many app instances/containers start simultaneously and open N connections each, overwhelming Redis. (2) **App servers × connections** — e.g. 100 app servers × 50 threads × 1 conn = 5000 conns, hitting `maxclients` (default 10k in many builds, but tunable). Solutions: use **connection pools** (reuse idle conns, limit max per app instance), prefer **persistent long-lived connections** over connect-per-request, configure `tcp-keepalive`, set `maxclients` appropriately with headroom, use lazy connect, and stagger startup. Also in serverless, pool across invocations or use external proxy. Monitor `INFO clients` (`connected_clients`, `blocked_clients`, `maxclients`).

**Deep explanation:** 
Metrics:
- `connected_clients`: total client connections.
- `client_recent_max_output_buffer`: largest output buffer.
- `blocked_clients`: clients blocked on BLPOP/WAIT/XREAD BLOCK.
- `maxclients`: limit (config). If exceeded, Redis rejects new connections (`ERR max number of clients reached`).

**Connection storm causes:** rolling deploys, autoscaling events, pod restarts — all open connections at once. Mitigations: jittered startup, slow ramp (connection warmup), pool with max connections per instance (e.g. 2–10 per app process), and Redis proxy (twemproxy/redis-cluster proxy) to consolidate.

**Pooling strategies:**
- **Per process pool:** maintain fixed-size pool of TCP conns, borrow/return. Avoid creating/destroying frequently.
- **Multiplexing:** some clients (ioredis) multiplex commands over single connection (pipeline + concurrent requests) — efficient. 
- **Cluster-aware pooling:** pool per node in Redis Cluster.
- **Timeouts:** set connect timeout, command timeout, idle timeout (close stale).

**Resource limits:** file descriptors (`ulimit -n`), container limits. Each connection is an FD. 10k conns = 10k FDs.

**Example sizing:** 50 app instances × 8 conns = 400 conns. With headroom, `maxclients 10000` is fine. If each needs 100 conns (thread-per-conn), 5000 total.

**TypeScript (ioredis persistent):**
```ts
const redis = new Redis({ host:'redis', port:6379, maxRetriesPerRequest: null, enableReadyCheck:true, lazyConnect:false });
// single connection, multiplexes
```
Or use pool in other clients.

**Best practices:** use long-lived conns, enable TCP keepalive (`tcp-keepalive` in redis.conf), monitor connection churn, alert on `connected_clients` near `maxclients`. In Kubernetes, readiness/liveness probes must not open new connections aggressively.

**Common mistake:** 
Opening a new Redis connection for every HTTP request (connection per request) — causes TCP handshake (3-way + TLS if any), slow startup, and connection storms under load. Also not setting `maxclients` and hitting "max number of clients reached".

### Q68. RDB snapshots in depth (fork/COW, save points, recovery, data-loss window).

**Thought process:** 
RDB is point-in-time snapshot written to disk (binary). Created via `SAVE` (blocking) or `BGSAVE` (background, fork). Uses Copy-On-Write (COW) — child process writes snapshot while parent continues serving writes, modifying pages causes copies. RDB gives compact backups, fast recovery, but has data-loss window (writes since last snapshot).

**Short interview answer:** 
RDB snapshots save dataset to `dump.rdb` at configured save points (`save <seconds> <changes>`). `SAVE` blocks Redis until done; `BGSAVE` forks a child that writes snapshot while parent runs. Fork uses Copy-On-Write: parent shares memory pages; when parent writes to a page, OS copies it so child sees consistent snapshot. Recovery: on startup, if `dump.rdb` exists, Redis loads it into memory (blocking). Data-loss window = time since last successful snapshot (up to N seconds or M changes). RDB is good for backups/disaster recovery and faster restarts with large datasets; downside is potential data loss on crash between snapshots.

**Deep explanation:** 
Save points (redis.conf):
```
save 900 1      # after 900s if >=1 key changed
save 300 10
save 60 10000
```
`BGSAVE` triggers if conditions met, or manually. `LASTSAVE` gives Unix timestamp of last snapshot.

**fork + COW:**
- Parent calls `fork()` → child gets copy of page table, shares all memory pages (read-only from child's view).
- Parent continues accepting writes (SET/DEL/etc.). For each page modified, kernel copies that page to child's private space.
- Child writes shared (unmodified) pages and copied pages to RDB file.
- On completion, child exits, parent may update `dirty` counters.

**Implications:**
- Fork is fast on modern kernels if dataset large but mostly unchanged (shared). 
- Memory overhead during BGSAVE: up to dataset size in worst case if all pages modified (all copied) — can cause OOM if memory tight.
- Disk I/O: child writes sequentially; impacts disk but parent unaffected except COW.
- Blocking: `SAVE` blocks all clients; `BGSAVE` blocks only during fork (usually ms). 

**Recovery:** `redis-server` loads `dump.rdb` at startup before accepting connections — loading is blocking, large datasets can take seconds–minutes. `redis-check-rdb` can verify.

**Tradeoffs:**
- **Pros:** compact, efficient for large datasets, minimal runtime overhead outside snapshots, good for backups.
- **Cons:** data-loss window between snapshots; fork can be expensive if dataset very large and memory constrained; COW spikes memory usage.

**Commands:** `SAVE`, `BGSAVE`, `LASTSAVE`, `INFO persistence` (`rdb_last_save_time`, `rdb_changes_since_last_save`, `rdb_bgsave_in_progress`).

**Example:** crash at T_last_save+500s with `save 900 1` → lose up to 900s of writes. Combine with AOF (Q69) for durability.

**Common mistake:** 
Assuming RDB is "durable" — it's periodic. Also thinking fork means full memory copy (it's COW). Believing `BGSAVE` never blocks — fork is a blocking sys call (copying page tables) though usually fast.

### Q69. AOF in depth (appendfsync always/everysec/no, rewrite, combined use of RDB+AOF).

**Thought process:** 
AOF (Append-Only File) logs every write command to disk in RESP format. On restart, replays AOF to rebuild state. Durability controlled by `appendfsync`: `always` (fsync after every write, safest, slowest), `everysec` (fsync once per second, balanced), `no` (let OS flush, fastest, least durable). AOF can grow large → rewrite creates compact version (minimal commands to reconstruct current state).

**Short interview answer:** 
AOF appends every write command to `appendonly.aof`. `appendfsync always` fsyncs on every write (max durability, high latency). `everysec` fsyncs once per second (default, good balance). `no` delegates to OS (max throughput, possible data loss of seconds). On restart, AOF is replayed sequentially (can be slow if very large, but rewrite mitigates). **AOF rewrite** (`BGREWRITEAOF`) forks child, rewrites AOF to contain shortest sequence of commands to produce current dataset (e.g. `SET key final` instead of 100 INCRs), reducing size. Best practice for durability+recovery is **RDB+AOF combined**: RDB gives fast point-in-time snapshot, AOF gives incremental durability since snapshot (`appendfsync everysec` strikes balance). In Redis 7+, `AOF-USE-RDB-PREAMBLE` can combine both.

**Deep explanation:** 
Appendfsync modes:
| Mode | Durability | Latency | Throughput | When to use |
|---|---|---|---|---|
| always | Highest (every write on disk) | Highest (fsync per op) | Lowest | Critical data, can tolerate latency (rare) |
| everysec | Good (last ~1s lost max) | Low | High | Default, balanced |
| no | Lowest | Lowest | Highest | Caches, non-critical, tolerate loss |

**AOF rewrite:** as AOF grows (many increments), replay time grows. Rewrite creates new compact AOF: child process reads current dataset in memory and writes minimal commands (`SET`, `HMSET`, `RPUSH` etc.) to temp AOF, then atomically replaces. Uses COW similar to BGSAVE (fork). Rewrite triggered by size: `auto-aof-rewrite-percentage`, `auto-aof-rewrite-min-size`, or manually `BGREWRITEAOF`.

**Rewrite mechanics:**
- Parent accumulates write commands in AOF buffer + also in "rewrite buffer" (so child doesn't miss writes during rewrite).
- Child writes compact snapshot commands to temp file.
- On finish, parent appends rewrite buffer to temp file, then renames temp to `appendonly.aof` (atomic), switches to new AOF.

**RDB+AOF (hybrid):**
- Enable both: `save` points + `appendonly yes`.
- On restart, Redis can load RDB preamble + AOF tail (if combined) for faster recovery than full AOF replay, while keeping recent writes.
- Provides point-in-time recovery + near-real-time durability.

**Data loss window:**
- `everysec`: at most 1 second of writes lost on crash (kernel/fsync timing).
- `always`: theoretically 0 if fsync succeeds, but disk/controller failures possible.
- `no`: OS dependent (up to OS page cache flush interval).

**Commands:** `BGREWRITEAOF`, `INFO persistence` (`aof_enabled`, `aof_last_rewrite_time_sec`, `aof_current_size`, `aof_base_size`, `aof_buffer_length`), `redis-check-aof`.

**Tradeoffs:** AOF larger than RDB (often 2–3x), rewrite uses CPU/memory, replay slower than RDB for very large datasets unless hybrid.

**Common mistake:** 
Setting `appendfsync always` thinking "fully ACID durable" — disk hardware can still fail; also ignoring AOF rewrite overhead. Confusing AOF with WAL in DBs (similar idea but Redis commands replayed).

### Q70. Replication mechanics — async replication, full sync vs partial resync, replication lag, read-after-write inconsistency, failover promotion.

**Thought process:** 
Redis replication is asynchronous by default: master propagates writes to replicas, but commits don't wait for replicas. Supports full resynchronization (RDB transfer) and partial resynchronization (PSYNC with replication ID + offset) to catch up after disconnection. Replication lag causes read-after-write inconsistency on replicas (read-only). Failover promoted replica becomes new master.

**Short interview answer:** 
Replication is master→replica, async: master acknowledges writes to clients before replicas confirm. On initial sync, replica does `PSYNC` (or `SYNC` legacy): if no previous replication state, master does `BGSAVE` + sends RDB + backlog → **full sync**. If replica has known replication ID and offset in backlog, master sends only incremental commands since offset → **partial resync** (much faster). **Replication lag** = master offset - replica offset (measured via `master_repl_offset`/`slave_repl_offset` or `INFO replication`). Because async, reading from stale replica can return old data after client wrote to master (**read-after-write inconsistency**). On failover, a promoted replica may have lagged (lost recent writes) unless forced; Sentinel/Cluster handle promotion (Q71–Q72). Use `WAIT` to block until replicas acknowledge (optional durability, but increases latency).

**Deep explanation:** 
Mechanics:
- Replica connects, sends `PSYNC <replid> <offset>`. 
- Master checks: if replid matches and offset in replication backlog → partial sync: stream buffered commands from offset. Else full sync.
- Full sync: master starts `BGSAVE`, sends RDB to replica, then streams commands received during BGSAVE from backlog.
- Replication backlog is a fixed-size ring buffer (`repl-backlog-size`) holding recent write commands.
- Async: `SET` returns OK to client once written to master; replica receives later via TCP stream.

**Lag measurement:**
```bash
redis-cli INFO replication
# master: connected_slaves, master_repl_offset
# replica: role=slave, master_host, master_port, slave_repl_offset, master_last_io_seconds_ago, lag?
```
Lag (seconds) can be estimated as `master_last_io_seconds_ago` on replica or (master_offset - slave_offset)/throughput. Also `redis-cli --latency` not directly.

**Read-after-write inconsistency:** 
Client writes `SET k v2` to master (ACK). Immediately does `GET k` against replica → may return v1 if not yet replicated. Solutions:
- **Route reads to master** for read-after-write critical keys (session creation, auth tokens).
- **Use `WAIT N t`** on write: block until >=N replicas have acked up to offset within timeout t (makes write effectively synchronous to replicas, trades latency). 
- **Stickiness by session/client ID** to same node.
- **Include version/timestamp** and check.
- **For user-facing flows**, read from master immediately after write.

**Failover considerations:** promoting a lagging replica means recent writes (not yet replicated) are lost. To minimize: use `WAIT`, monitor lag, set `min-replicas-to-write`/`min-replicas-max-lag` (master stops accepting writes if too few replicas caught up) — protects against split-brain? not fully. Sentinel/Cluster use quorum/voting.

**Replication ID:** master has `run_id` (replid). On promotion, new master gets new replid (or can preserve in some cases) affecting partial resync for other replicas.

**Common mistake:** 
Assuming replication is synchronous — it's async by default. Treating all replicas as "equally fresh" for read-after-write. Also thinking partial resync works after any disconnection (needs backlog coverage).

### Q71. Redis Sentinel in depth — monitors, quorum, voting, sdown/odown, what Sentinel does NOT do (sharding).

**Thought process:** 
Sentinel provides high availability for standalone Redis masters: monitors masters+replicas, detects failures (subjective down sdown, objective down odown), uses quorum+voting to elect new master, and notifies clients via sentinel API. It does NOT shard data (no Cluster slot distribution) — that's Redis Cluster. Also doesn't proxy data in all setups (clients query sentinel to discover master).

**Short interview answer:** 
Redis Sentinel (HA) consists of 3+ sentinel processes monitoring one or more masters. **Monitors:** send `PING`, check replication. **sdown (subjective down):** a single sentinel marks master unreachable. **odown (objective down):** quorum of sentinels agree master is unreachable. After odown, sentinels vote to elect a **leader sentinel**, which then promotes the best replica (based on priority, replication offset, runid) to master and reconfigures others to replicate from new master. **Quorum** = number of sentinels that must agree to trigger failover. Sentinel clients use `SENTINEL get-master-addr-by-name` or subscribe to events to discover current master. Sentinel does **not** do sharding (no hash slots), does not split dataset across nodes — for sharding use Redis Cluster. It also doesn't guarantee no data loss (lagging replica promotion possible).

**Deep explanation:** 
Architecture: distributed system of sentinels (odd number recommended, >=3) to avoid split-brain. They form a quorum and use Raft-like voting for leader election.

**States:**
- **sdown:** local sentinel thinks master is down (timeout on PING, or error).
- **odown:** quorum reached across sentinels that master is sdown → objective down, eligible for failover.
- **failover in progress:** leader elected, promotion happening.

**Election criteria for new master:**
1. Replica must be up (connected).
2. Lowest `slave-priority` (0 means cannot be promoted).
3. Highest replication offset (most recent data).
4. If tie, lexicographically smaller `runid`.
5. Also consider `min-replicas-to-write` constraints.

**Quorum & voting:** `quorum` is the minimum number of sentinels that need to agree master is down to initiate. Leader election requires majority of sentinels. Example: 5 sentinels, quorum=2 → odown when 2 agree, but leader needs 3 votes.

**Client discovery:** sentinel-aware clients query sentinel: `SENTINEL MASTERS`, `SENTINEL GET-MASTER-ADDR-BY-NAME <name>`, or subscribe to `+switch-master` events. Some clients maintain connection pool and auto-reconnect to new master.

**What Sentinel does NOT do:**
- **No sharding:** dataset is not partitioned; each master holds full dataset. Horizontal scaling of data requires Cluster.
- **No data proxying:** clients talk directly to master/replicas after discovery (sentinel tells them addresses).
- **No automatic resharding:** fixed topology per master set.
- **No multi-DC automatic routing beyond configuration.**

**Limitations:** network partitions can be tricky; lagging replicas cause data loss on promotion; split-brain if quorum misconfigured. Also monitoring overhead.

**Example config snippet (conceptual):**
```
sentinel monitor mymaster 127.0.0.1 6379 2
sentinel down-after-milliseconds mymaster 30000
sentinel failover-timeout mymaster 180000
sentinel parallel-syncs mymaster 1
```
(quorum=2 means 2 sentinels must agree)

**Common mistake:** 
Thinking Sentinel provides sharding/scaling — it only provides HA (failover). Also assuming zero data loss on failover without `WAIT`/`min-replicas-to-write`.

### Q72. Redis Cluster in depth — 16384 hash slots, slot->node mapping, MOVED/ASK redirects, cluster-aware clients, resharding, adding/removing nodes.

**Thought process:** 
Redis Cluster is distributed sharding + HA: dataset split into 16384 hash slots, each slot owned by a master (and replicated). Clients get slot->node mapping and follow MOVED/ASK redirects. Supports resharding, adding/removing nodes online.

**Short interview answer:** 
Redis Cluster shards data across masters using **16384 hash slots**: key → slot = `CRC16(key) mod 16384`. Each master owns a subset of slots; replicas provide HA for their master. Cluster is gossip-based (nodes exchange state). Clients must be **cluster-aware** (know slot mapping). When client queries wrong node, server returns **MOVED** (permanent redirect, update client mapping) or **ASK** (temporary, during reshard, ask specific node for this key). **Resharding** moves slots between nodes (online, with `CLUSTER REBALANCE`/manual `MIGRATE`). **Adding nodes:** empty node added, then slots assigned/migrated to it. **Removing nodes:** move slots out, then `CLUSTER FORGET`. Cluster supports multi-key ops only if all keys in same slot (use hash tags `{...}`), and transactions are limited to same slot.

**Deep explanation:** 
Slot mapping: fixed 16384 (sufficient to avoid huge slot tables, allows efficient routing). Each key maps to exactly one slot.

**Redirects:**
- **MOVED slot ip:port:** slot permanently moved to another node. Client should update its local slot cache (CLUSTER SLOTS mapping).
- **ASK slot ip:port:** slot is being migrated: key may be on source or target. Client must issue `ASKING` then query target for this specific key (doesn't update cache). After migration completes, MOVED follows.

**Cluster-aware clients:** maintain mapping of slot ranges → node. On startup get from any node (`CLUSTER SLOTS`), refresh on MOVED, handle ASK. Libraries like ioredis/redis-py are cluster-aware.

**Resharding:** move hash slots from source to target without downtime. Steps: set target as importer for slot (with `CLUSTER SETSLOT <slot> IMPORTING <source>`), source as exporter (`MIGRATING <target>`), then move keys in slot (`MIGRATE` for existing keys, or live migration — during migration, source serves if key still there, else returns ASK). Can be done gradually.

**Gossip protocol:** nodes exchange `ping`, `pong`, `meet` to propagate cluster state (who owns which slots, failures). Failure detection similar to Sentinel but decentralized.

**HA:** if master fails and majority of masters agree (quorum), its replica is promoted (auto-failover). Requires at least 3 masters in typical setups to tolerate splits.

**Constraints vs standalone:**
- Multi-key commands (`MGET`, `DEL` with multiple keys) require all keys in same hash slot.
- `WATCH`/transactions limited to same slot.
- Database is always DB 0.
- Some commands not supported or behave differently.

**ASCII (slot mapping):**
```
Key "user:123:profile" -> CRC16 -> slot 1234
Cluster state: slot 1234 owned by M1:7000
Client -> M2:7001 GET key -> MOVED 1234 127.0.0.1:7000
Client updates cache, retries M1:7000
```

**Common mistake:** 
Thinking Cluster is just HA like Sentinel — it's sharding. Also assuming clients can route randomly (need cluster awareness). Believing you can easily split a single hot key's slot (slots are atomic units; fix via key-splitting). 

### Q73. Hash tags `{user:123}` — why multi-key ops/transactions need same slot, downsides of overusing tags.

**Thought process:** 
Hash tags force keys sharing the same `{...}` substring to hash to the same slot: `slot = CRC16("{user:123}:profile") == CRC16("{user:123}:orders")`. This enables multi-key operations (e.g. `SUNION`, `DEL k1 k2`) and same-slot transactions/WATCH in Cluster. Overusing creates hot slots (many keys pinned to same slot) and reduces sharding flexibility.

**Short interview answer:** 
In Redis Cluster, multi-key commands and transactions require all keys to be in the same hash slot. **Hash tags** `{tag}` override hashing: only the content inside braces is hashed. So `{user:123}:a` and `{user:123}:b` map to same slot, allowing `MGET {user:123}:a {user:123}:b` or `MULTI/EXEC` across them. This is useful for atomic operations on related entities. Downsides: overusing tags (e.g. putting same tag on all keys) pins entire dataset to one slot (hot shard, defeats sharding). Also limits load balancing and resharding granularity. Use tags sparingly for tightly coupled keys that must be operated together atomically.

**Deep explanation:** 
Hashing rule:
- If key contains `{...}`, hash is computed on substring between `{` and `}`. 
- If multiple `{}`, only first `{` considered? e.g. `foo{{bar}}` hashes on `{bar}`? or `{{bar}}`? Redis uses first `{` and next `}`: content inside.
- Keys without tags hash on whole key.

**Enables:**
- `DEL {user:123}:cart {user:123}:wishlist` (multi-key DEL) in same slot.
- `SUNION {g1}:a {g1}:b` for same slot.
- `WATCH {u}:bal {u}:txnlog` + `MULTI/EXEC` across related keys.
- Lua scripts with multiple keys must all be in same slot (Cluster constraint).

**Downsides of overuse:**
- **Hot slot:** tagging many unrelated keys with same tag concentrates traffic on one master.
- **No horizontal scaling for that tag:** all operations for that aggregate go to one node.
- **Resharding friction:** moving that slot moves all tagged keys together.
- **Blast radius:** failure of that node affects all tagged entities.

**Example:**
```bash
# same slot
SET {user:123}:name Alice
SET {user:123}:age 30
MGET {user:123}:name {user:123}:age  # works in Cluster

# different slots (no tag)
SET user:123:name Alice
SET user:124:name Bob  # likely different slots
```

**Best practices:** tag only when atomicity/co-location is required (e.g. all keys for a single user transaction). Don't use global tags like `{app}`. Keep tag scope narrow (entity id). For counters, consider key-splitting instead (Q59).

**Common mistake:** 
Using `{user:123}` on every key "just in case" — creates artificial hot spots. Also assuming hash tags work in standalone Redis (they're a no-op in routing but syntax is accepted; effect is Cluster-specific).

### Q74. Redis Streams internals — append-only log, stream IDs, XADD/XREAD, retention (MAXLEN/MINID), replay.

**Thought process:** 
Streams are append-only, persistent logs with consumer groups support. Each entry is a sequence of field-value pairs with a unique ID (`<milliseconds>-<sequence>`). Streams support range reads, blocking reads, retention trimming, and replay from any point. Internals resemble a log (like Kafka topic partition in structure, but simpler).

**Short interview answer:** 
Redis Stream is an append-only log: `XADD` appends entries with auto-generated IDs (`<time>-<seq>`) in strict order. `XREAD` reads forward from a given ID (or `0-0` for start, `$` for end), optionally blocking with `BLOCK`. Each stream is a radix tree-like structure of entries stored in memory (and persisted via RDB/AOF). **Retention:** `MAXLEN ~ N` (approximate trimming, efficient) or `MINID` trims entries older than ID. **Replay:** consumers can read from any historical ID (e.g. `0-0`, or last processed) to reprocess entries — streams persist until trimmed. This makes them suitable for event sourcing, audit logs, and reliable queues with consumer groups.

**Deep explanation:** 
Stream ID format: `timestamp-sequence`. Ensures global ordering (entries added at same ms get incrementing seq). Can specify ID explicitly (e.g. `*` auto, or `1234567890000-0`).

**Key commands:**
- `XADD mystream * key1 val1 key2 val2` → appends, returns ID.
- `XLEN mystream` → length.
- `XRANGE mystream start end [COUNT n]` → range (inclusive). Use `-` for earliest, `+` for latest.
- `XREVRANGE` → reverse.
- `XREAD [BLOCK ms] STREAMS mystream id` → read entries after id. `$` means "from now on" (only new). `0` or `0-0` from beginning.
- `XTRIM mystream MAXLEN [~] count` → trim to count entries (approximate `~` is faster, may keep a bit more).

**Internals (high level):** stream stored as a radix tree of "nodes" containing entries (field-value pairs). Entries are linked in order. `XADD` is O(1) amortized. `XRANGE` by ID is efficient via tree traversal. Memory depends on number of entries and field names (can be compressed in some representations).

**Retention:** without trimming, streams grow unbounded (memory). Use `MAXLEN ~ 10000` for approximate capped size, or `MINID = <id>` to trim older than timestamp. Trimming is lazy/periodic on writes (not instant full scan). Also can trim via `XADD ... MAXLEN ... * ...` in same command (Redis 6.2+).

**Replay:** since entries remain until trimmed, any consumer can start from `0-0` and replay entire history. This differs from Pub/Sub (ephemeral, no history). With consumer groups, each group tracks its own last-delivered ID (PEL + `XACK`).

**Persistence:** streams are part of dataset, persisted in RDB and AOF same as other keys. On restart, stream state restored.

**ASCII (log structure):**
```
Stream S: [ID1: {f1:v1}, ID2: {f2:v2,...}, ID3: ...] (append-only, ordered)
XADD appends to tail (ID3 > ID2)
XRANGE reads range by ID order
XREAD from last ID returns only new entries
```

**Use cases:** event logs, job queues (with groups), change data capture streams, metrics ingestion, audit trails.

**Common mistake:** 
Confusing Streams with Pub/Sub (Streams are durable/logged, Pub/Sub is fire-and-forget). Also using `$` for replay (it means "new messages only"). Thinking Streams replace Kafka in all cases (Kafka has partitions, retention policies, replication model; Streams simpler, single-node/log scale constraints).

### Q75. Consumer groups + PEL + XACK + XAUTOCLAIM end-to-end, worker crash recovery walk-through.

**Thought process:** 
Consumer groups (CG) allow multiple consumers to share work from a stream, with each entry delivered to exactly one consumer in group. PEL (Pending Entries List) tracks entries delivered but not yet acknowledged. `XAUTOCLAIM` helps crashed workers by transferring pending entries to other consumers after idle time.

**Short interview answer:** 
`XGROUP CREATE stream groupname $ MKSTREAM` creates group (starting from `$` = new entries only, or `0-0` for history). `XREADGROUP GROUP groupname consumername STREAMS stream >` reads new pending entries for this group (> means "next not yet delivered to anyone in group"). When read, entry is added to **PEL** (pending entries list) for that (group, consumer). Consumer processes entry, then calls `XACK groupname stream entryid` to remove from PEL. If consumer crashes before XACK, entry remains pending. Other consumers can use `XAUTOCLAIM stream groupname claimant min-idle-time start count` to claim entries idle > min-idle-time from dead consumers (transferring ownership). Also `XPENDING` inspects PEL. This provides at-least-once delivery and crash recovery.

**Deep explanation:** 
End-to-end flow:

1. **Create stream + group:** `XADD events * type=order id=5`. `XGROUP CREATE events workers $ MKSTREAM` (read only new messages from now).
2. **Consumer reads:** `XREADGROUP GROUP workers c1 STREAMS events > COUNT 1` → gets next entry E1, moves E1 to PEL (c1 is owner, delivery count=1, idle=0).
3. **Process:** c1 does business logic (e.g. update DB). 
4. **Ack:** `XACK workers events E1` → removes from PEL.
5. **Crash before ack:** c1 dies, E1 stays in PEL owned by c1.
6. **Recovery:** c2 (or other) runs `XAUTOCLAIM events workers c2 60000 - + COUNT 10` (claim entries idle > 60s, from any start). Transfers ownership to c2, increments delivery count, resets idle timer. c2 processes and XACKs.
7. **Visibility:** `XPENDING events workers` shows pending summary; `XPENDING events workers - + 10` lists entries.

**Key IDs/semantics:**
- `>` in XREADGROUP = messages never delivered to any consumer in this group.
- `0-0` or specific ID reads pending/history for this consumer? can also use `XREADGROUP` with ID to re-read pending if needed, but typically `>` is used.
- **At-least-once:** entry may be delivered multiple times (if crash before XACK, then claimed and redelivered) — consumers must be idempotent (Q76).
- **Delivery count:** increments on each claim/redelivery (helps detect poison messages, e.g. > N retries → DLQ).
- **Idle time:** time since last delivery/claim to this consumer.

**XAUTOCLAIM parameters:** `XAUTOCLAIM <key> <group> <consumer> <min-idle-time> <start> <count> [justid]` returns claimed entries and possibly a new start ID. `-` means from smallest ID in PEL.

**ASCII (crash recovery):**
```
c1: XREADGROUP -> gets E1 (PEL: E1 owned by c1, idle 0)
c1 crashes (no XACK)
t=65s passes: c2 does XAUTOCLAIM min-idle 60000 -> claims E1 (now owned by c2, deliv count 2)
c2 processes E1 -> XACK -> removed from PEL
```

**Edge cases:** claiming very old entries, race between claimers (XAUTOCLAIM is atomic per entry), dead consumers never recover. Also need to handle "stuck" pending (poison messages).

**Common mistake:** 
Using `$` as group start and then expecting history replay (use `0-0`). Forgetting idempotency (at-least-once). Not setting min-idle-time high enough causing premature reclaims, or too low delaying recovery.
