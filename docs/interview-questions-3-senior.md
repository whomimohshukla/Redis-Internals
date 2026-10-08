# Redis Interview Questions — Senior / Staff (Q81–Q120)

This file is Part 40 of a structured Redis + caching interview-prep journey, specifically curated for Senior/Staff and 50-LPA style backend & system-design rounds. It covers production-grade topics including high-scale caching, multi-region, resilience, observability, data modeling, and operational hardenings with concrete trade-offs.

## Senior / 50-LPA (Q81–Q120)

### Q81. How would you design a read-heavy product catalog cache targeting ~1M QPS end-to-end?

**Thought process:**
The goal is not "just add Redis", but to reason through keys, TTLs, hit ratio, invalidation, failure modes and capacity at 1M QPS. A senior should account for network, serialization, client-side pooling, and DB backpressure. You must quantify assumptions and show where cache helps vs where it fails.

**Short interview answer:**
I'd treat caching as a layered system (CDN/static, L1 in-process per service, Redis read replicas, and DB). For a catalog, I'd use stable composite keys (e.g. `cat:v1:prod:{id}`), read-through with singleflight to prevent stampede, conservative TTLs by volatility (metadata 5-15m, prices/inventory lower), and change-driven invalidation. Plan for 95%+ cache hit ratio, keep p99 Redis < 2ms, protect DB with circuit breakers/timeouts, and rehearse cache-only partial failure.

**Deep explanation:**
At 1M QPS read-heavy, network latency dominates. Assume 1KB objects: Redis memory 1KB * 10M hot keys = 10GB (plus overhead ~30-40% → ~14GB). Use connection pooling (dozens of conns per app host, not per request). For key design: avoid dynamic queries in keys; version by entity (v1) to allow safe rollout. TTL strategy: static catalog entries 10-30m, semi-dynamic (ratings) 2-5m, highly dynamic (stock) 30-120s or event-invalidated. Invalidation: prefer pub/sub + version bump or outbox on writes; never rely on KEYS in prod. Failure modes: Redis down → fall back to DB but throttle (max 100k QPS theoretical cap depends on DB). Cache stampede: use Redis `GETEX` + in-process singleflight. Hit ratio target 99%: remaining 1% (10k QPS) must be DB-safe (query cache-disabled heavy queries, index-only). Monitor evictions: if `evicted_keys` rises, capacity is wrong. Consider read replicas to scale reads. For 1M QPS, horizontal app scale + Redis Cluster read endpoints. Document SLOs: catalog p99 < 100ms, Redis hit p99 < 2ms.

**Common mistake:**
*Weak:* "Just put everything in Redis with 1 hour TTL."
*Correction:* 1M QPS requires layered caching, quantified memory/bandwidth, explicit invalidation, and DB protection for cache misses/failures.

---

### Q82. You have 99% hit ratio but your relational DB is still overloading at peak. How would you reason about this numerically?

**Thought process:**
Hit ratio is a global average; distribution of misses matters (hot keys missing, cold set, thundering herd, scan-like reads). Also cache keying might miss partial results. A staff answer must compute the miss traffic and find the true bottleneck.

**Short interview answer:**
99% hit ratio means 1% of 1M QPS = 10,000 misses/sec hitting DB. If your DB can sustainably serve only 3,000–5,000 QPS for these queries, it will overload. I'd compute miss volume by endpoint, check if misses are concentrated (single key/route), measure cache penetration, and reduce miss cost via negative caching, request coalescing (singleflight), or pre-warming.

**Deep explanation:**
Assume traffic T=1M QPS, H=0.99, misses M=10k/s. DB capacity C depends on query cost: an index lookup ~1-5ms → ~200-1000 QPS/core; a join ~10-50ms → 20-100 QPS/core. So 10k/s * 5ms = 50k core-ms/sec = 50 cores just for misses. Also check cache coherence: if TTLs expire together (synchronized), you get burst misses (stampede) → effective M spikes to 50-80k/s. Negative caching (cache "not found" for 30-120s) helps if 20% of misses are missing entities. Request coalescing: 100 clients missing same key at same time → 1 query, not 100. Bloom filter before Redis to avoid keyspace probes? Rarely useful if keys are known. Also "cache hit ratio" might ignore partial cache (e.g. only product row cached, not related). I'd segment by `cache_miss{route=...}` and p99 DB latency per route. Conclusion: fix concentration + miss amplification first, then raise C.

**Common mistake:**
*Weak:* "Increase Redis hit ratio to 99.9%."
*Correction:* 1% of 1M is 10k/s — often enough to overload DB; focus on reducing miss amplification and per-miss cost, not just ratio.

---
### Q83. How would you capacity-plan Redis for 100M users (memory, overhead, fragmentation, replicas, shards, bandwidth, connections)?

**Thought process:**
Capacity planning is a numbers game. A staff candidate must estimate per-user footprint, account for Redis memory overhead (dict/hash, SDS, zsets/lists), fragmentation, replication buffer, and client connections. Also consider peak vs steady state.

**Short interview answer:**
I'd model per active user (session + small cache) ~200-500 bytes, scale to 100M with 10-30% active concurrency, target ~3-10GB hot set, plan for 30-40% overhead + fragmentation → ~15GB usable becomes ~20-25GB provisioned, use Redis Cluster with shards, read replicas for HA, size connection pool (maxclients), and monitor memory fragmentation ratio.

**Deep explanation:**
Assume 20% concurrent = 20M sessions. Each session JSON ~300 bytes + key overhead (e.g. `sess:{uid}`) ~60-80 bytes + TTL. Total ~380 bytes * 20M = ~7.6GB raw. Redis overhead: keys in dict, values (SDS), TTL dict → ~1.3-1.5x for simple strings. Memory allocator (jemalloc) fragmentation + RDB/AOF buffers → add 20-30%. So plan ~7.6*1.4*1.25 ~ 13.3GB per primary set. With 2 replicas, total memory across nodes larger but same dataset size. Shards: if single node > 200GB risky, split (e.g. 4 shards * 3.5GB). Network: 1M ops * (say) 1KB = 1GB/s peak; ensure NICs, cross-AZ. Connections: 10k app pods * 20 conns = 200k; set `maxclients` appropriately, use connection pooling. Eviction policy: `allkeys-lru` only if truly cache; if stateful, avoid. Alert on `used_memory` > 80%, `mem_fragmentation_ratio` > 1.5 sustained.

**Common mistake:**
*Weak:* "100M users * 1KB = 100GB" without overhead/active set.
*Correction:* Don't multiply total users by per-user unless all active; account for overhead (30-50%) and fragmentation.

---
### Q84. Multi-region Redis: active-active vs active-passive, replication lag, conflict/staleness choices, what for sessions vs counters?

**Thought process:**
Multi-region means CAP trade-offs. Redis replication is async (typically), so lag causes read-after-write staleness and potential conflicts on writes. Sessions vs counters have different durability/consistency needs.

**Short interview answer:**
Active-passive (primary in one region, read replicas in others) gives strong write consistency at primary and read scalability, but cross-region reads lag. Active-active (CRDT-based like Redis Enterprise/Active-Active or custom) improves local writes/latency but allows conflicts; avoid naive multi-master without conflict resolution. For user sessions, prefer sticky to home region or tolerate small lag; for counters (likes/views), choose monotonic or accept approximate counts.

**Deep explanation:**
Active-passive: RPO=0 for writes at primary (if sync) but Redis async → RPO>0 on failover risk; replication lag (ms to secs) breaks read-after-write. Route: read from local replica only if "read-your-writes" not required, else read from primary or use session stickiness. Active-active: write to local → replicate; conflicts on same key (e.g. INCR). Solutions: last-write-wins (LWW) with timestamps but loses increments; CRDT counters (PN-Counter) preserve increments. Network: inter-region RTT 50-150ms; bandwidth cost high. For sessions: prefer local read-replica + short TTL, or Redis in each region with session replication limited. For counters: often acceptable to be eventually consistent (eventual) with idempotent merges. Also consider "global" locks avoid cross-region. Never assume strong consistency across regions.

**Common mistake:**
*Weak:* "Just set up multi-master" without conflict resolution.
*Correction:* Async replication + multi-writer needs CRDTs or sharding by region; don't do naive multi-master for aggregates.

---
### Q85. Redis Cluster vs Sentinel vs single primary — decision framework with numbers (availability, scale, ops cost)?

**Thought process:**
Choose based on scale (data size, ops/sec), HA needs (RTO/RPO), ops complexity, cost. Numbers make it concrete.

**Short interview answer:**
Single primary: simple, good for <10GB, <50k QPS; no automatic sharding. Sentinel: HA + automatic failover, read replicas, still single primary (memory/CPU bottleneck). Redis Cluster: automatic sharding + HA + horizontal scale, supports >100GB, >500k QPS; higher ops complexity (slots, migrations). Pick Cluster if data > primary capacity or writes/reads need scaling; Sentinel if HA only.

**Deep explanation:**
Availability: single node 99.9% (MTTF/MTTR), Sentinel/Cluster can hit 99.99% with proper clients. Failover: Sentinel ~10-30s detection+promote (tunable), Cluster faster in many cases. Scale: single primary limited by RAM/CPU; Cluster spreads to N nodes. Memory: 100GB split across 8 shards easier. Connections: Cluster clients route by slot; need smart clients. Ops: Sentinel needs quorum, monitoring; Cluster needs rebalancing/migrations (brief latency). Cost: more nodes. Example: 80k QPS read-heavy → Sentinel + replicas fine; 500k QPS mixed or 50GB data → Cluster. Also note: Sentinel doesn't shard; Cluster requires even slot distribution. Avoid cross-shard multi-key ops without care.

**Common mistake:**
*Weak:* "Always use Cluster."
*Correction:* Overengineering for small caches; prefer simplest that meets SLOs with quantified reasons.

---
### Q86. A single hot key takes 1M reads/sec — full solution set (L1 cache, replicated hot key, CDN, coalescing, key design) and why adding nodes fails?

**Thought process:**
Redis Cluster shards by hash slot; all reads for a key go to the slot owner (single node). Adding more nodes gives more slots/nodes but the same key stays on same owner → still bottlenecked. Need to replicate/read-amplify or move reads closer to clients.

**Short interview answer:**
Adding nodes doesn't help a single hot key because sharding is by key→slot. Solutions: (1) in-process L1 cache per app instance (TTL) to absorb reads locally, (2) read coalescing (singleflight) so many concurrent misses become one fetch, (3) replicate hot key to read replicas or use "read-through + local cache" + CDN for static, (4) redesign keying (split by region/tenant/version) if logically splittable, (5) back pressure + negative caching. Also consider "hot key" proxy or moving to cache-aside with short local TTL.

**Deep explanation:**
Example: 1M QPS to key K on node N. Local L1: if 100 app pods, each caches for 100ms → ~10k QPS to Redis. Coalescing: within process, collapse concurrent requests. CDN only for public/static. If not splittable (single entity), L1+coalescing is standard. Replicated hot key: publish updates to replicas? Complex. Another: use client-side caching (Redis 6+) carefully. Why adding nodes fails: key hash % 16384 fixed → slot owner fixed; reads still routed to owner. Shard count doesn't change per-key load. You must reduce read fanout to the authoritative node, not the cluster size. Monitor `keyspace_hits/misses` per key? Use `redis-cli --hotkeys` or `MONITOR` limited; prefer sampling. Also consider circuit breaker if owner overloaded.

**Common mistake:**
*Weak:* "Scale Redis Cluster to more nodes."
*Correction:* Horizontal scale doesn't fix per-key hotspot; use local caching + coalescing + key redesign.

---
### Q87. Hot shard after adding nodes — hash slot imbalance, slot migration, rebalancing risk (latency spikes, cluster-wide stall)?

**Thought process:**
Rebalancing moves hash slots between nodes; during migration, keys in transit can cause increased latency, and large migrations affect cluster. Also adding nodes alone doesn't rebalance unless you move slots.

**Short interview answer:**
Adding nodes creates empty nodes; if slots not migrated, hot keys remain on same shard. To rebalance, use `CLUSTER REBALANCE` or manual `CLUSTER SETSLOT` + `MIGRATE`. Risks: `MIGRATE` blocks key access during transfer of large keys (or uses atomicity carefully), increased RTT, pipeline stalls, and if source/dest busy → latency spikes. Also during failovers/rebalances, clients may see `MOVED`/`ASK`. Mitigate by migrating small slots incrementally during low traffic, avoid migrating hot slots together, and monitor p99.

**Deep explanation:**
Cluster: 16384 slots distributed. Hot shard = many hot keys map to its slots. Migration: Redis copies key data, updates slot ownership. `MIGRATE` is synchronous for the key being moved (blocking for that key) → if migrating 10GB key, that operation blocks; better to avoid huge keys. Also `ASK` redirection during migration window. Rebalancing algorithms (e.g. redis-trib) move slots one by one. Risks: cluster-wide impact if network constrained, memory pressure on dest, and client reconnect storms. To detect: `CLUSTER NODES`, `CLUSTER SLOTS`, per-node ops/sec. Mitigations: throttle migrations, prefer adding nodes and rebalancing gradually, split hot keys at application level (redesign), or use read replicas. Never rebalance during peak without rehearsals.

**Common mistake:**
*Weak:* "Just rebalance everything at once."
*Correction:* Incremental slot migration with monitoring; huge keys during migration cause spikes.

---
### Q88. Design a distributed rate limiter for a public API gateway (algorithm choice, Lua atomicity, multi-node coordination, burst semantics, headers)?

**Thought process:**
Need low latency (microseconds), correct under concurrency, multi-node consistency trade-offs. Algorithms: fixed window, sliding window (log or counter), token bucket, leaky bucket. Distributed: Redis central store gives atomicity via Lua/transactions.

**Short interview answer:**
Prefer token bucket for burst + steady rate, or sliding window counter for smoother enforcement. Implement in Redis Lua for atomicity (read+update+expire). For single Redis, Lua is sufficient. For multi-node (multiple gateways), use Redis as shared store (eventually consistent not enough; atomic check+decr). Return RFC 7231-style headers (`X-RateLimit-*`, `Retry-After`). Handle burst: allow burst capacity (bucket size > refill rate). For very strict global limits, single Redis; for per-region, can shard by key.

**Deep explanation:**
Token bucket: refill tokens at rate r, capacity b; on request: if tokens>=1 take 1 else reject. State: `{tokens, last_refill_ts}`. Sliding window log (ZSET with timestamps): count recent entries < now-window; accurate but memory O(number of requests in window). Sliding window counter (approximate): use multiple buckets (e.g. 1s + 60s) to reduce memory. Lua example sketch: `local v = redis.call('INCR', key); if v==1 then redis.call('EXPIRE', key, window) end; ...` for fixed window (atomic). For token bucket, read+compute+write in one Lua script. Multi-node: Redis is single source of truth; network RTT ~1ms acceptable. Coordination avoids "each node has own bucket" (uncoordinated) allowing 2x traffic. Burst semantics: e.g. 1000 req/min with burst 100. Headers: inform clients. Edge cases: clock skew minimal, Redis latency p99<1ms. Note: Redis single-threaded makes Lua atomic. For global, avoid cross-region Redis for hot paths (use local+global with leaky).

**Common mistake:**
*Weak:* "Each gateway has its own counter."
*Correction:* Uncoordinated allows burst amplification; use shared Redis with atomic Lua.

---
### Q89. Sliding-window rate limiter with sorted sets — implementation sketch, memory at scale, log vs counter trade-off?

**Thought process:**
Sorted sets (ZADD/ZREMRANGEBYSCORE/ZCOUNT) enable sliding window by timestamp. Accurate but memory grows with request rate*window. Alternatives trade accuracy for memory.

**Short interview answer:**
Use ZSET keyed by `rl:{id}` storing member = unique request id (or timestamp+nonce) with score = current epoch ms. On request: remove old entries with score < now - window_ms; count = ZCARD or ZCOUNT; if count >= limit reject else ZADD + EXPIRE. This is precise. Memory: ~ (limit + burst) entries * (say) 2*8 bytes + overhead ~ 100-200 bytes per key/window max; for 10k req/s * 1min window = 600k entries ~ 50-100MB total across keys is fine if many keys. Trade-off: log (ZSET) is exact; counter approximation (e.g. sliding window with 2 counters) uses O(1) memory but boundary errors.

**Deep explanation:**
Sketch (conceptual): 
- key = `rate_limit:user:123:api`
- now = ms()
- window = 60000
- redis.call('ZREMRANGEBYSCORE', key, 0, now-window)
- c = redis.call('ZCARD', key)
- if c >= limit: reject (with Retry-After)
- else: redis.call('ZADD', key, now, now..':'..uuid); redis.call('PEXPIRE', key, window+1000); allow

Lua ensures atomicity. Memory: each entry needs score (double) + member (string) + dict overhead ~ 3*8+8 + string ~ 50 bytes? Roughly 40-80 bytes; 10^6 entries ~ 80MB. For per-user limits, use key per user+endpoint. Also can cap by trimming to limit (if over, reject). Alternatives: Hystrix-style local only bad for distributed; Redis-cell-like fixed window simpler. Sliding log accurate for "requests in last N seconds". Approximate sliding counter: store current window count + previous window weighted — less memory, small error at boundaries (e.g. 1% acceptable).

**Common mistake:**
*Weak:* "ZADD without expiring old members" (ZSET grows unbounded).
*Correction:* Always ZREMRANGEBYSCORE + EXPIRE; also consider periodic cleanup.

---
### Q90. Design an idempotent payment API (Idempotency-Key lifecycle, TTL, in-flight collisions, stored responses, failure/retry semantics, DB uniqueness backstop)?

**Thought process:**
Payments must not double-charge on retries (network errors). Idempotency requires keying requests, storing responses, handling in-flight requests (concurrent retries), and DB constraints as ultimate guard.

**Short interview answer:**
Accept `Idempotency-Key: <uuid>` header. On first attempt: store key in Redis with state `IN_FLIGHT` (TTL ~30s), process payment transactionally, store response + status in Redis with longer TTL (e.g. 24h) and return it. On retry: if key has stored response → return it; if `IN_FLIGHT` → return 409/423 or poll (client retry) to avoid double processing; if missing/expired → treat as new but DB uniqueness (e.g. payment intent key, charge idempotency) prevents duplicates. Always use DB unique constraints (e.g. `uq(idempotency_key, merchant_id)`) as backstop.

**Deep explanation:**
Lifecycle: client generates key per logical operation. Redis keys: `idem:pay:{key}` → value `{status: IN_FLIGHT|COMPLETED|FAILED, resp_hash, http_code, ts}`. First: SETNXEX with IN_FLIGHT (atomic) to acquire lease; if exists and completed → replay. In-flight collision: another retry arrives while processing → do not reprocess; return 202/409 indicating in-flight (or client should retry after backoff). Stored responses: cache full response (or hash) for replay within TTL (compliance: keep as needed, but not forever). Failures: on timeout, do not store "success" unless committed; store error with shorter TTL. Idempotency window: client decides, server enforces reasonable TTL (e.g. 24-48h). DB backstop: insert idempotency record in same transaction as payment (INSERT ... ON CONFLICT DO SELECT) or use unique key on (idempotency_key). This ensures even if Redis lost state, DB prevents double charge. Also distinguish "create payment" vs "refund". Never assume Redis durability for critical state.

**Common mistake:**
*Weak:* "Just use Redis SETNX without IN_FLIGHT state and DB constraint."
*Correction:* Redis can expire; without DB uniqueness, process crash + retry can double-charge.

---
### Q91. Distributed lock for a cron job fleet — token ownership, safe release via Lua, fencing tokens, what under pause/partition, why not consensus?

**Thought process:**
Locks prevent duplicate cron runs across fleet. Safe release requires checking ownership (prevent releasing someone else's lock). Fencing prevents processing old/stale holders. Network partitions and GC pauses create risks.

**Short interview answer:**
Use Redis `SET key value NX PX ttl` to acquire with lease (token = UUID). To release, run Lua: `if redis.call("GET", key)==ARGV[1] then return redis.call("DEL", key) else return 0 end` (check-and-delete) — never `DEL` blindly. Use fencing token (incrementing number, e.g. Redlock's generation or stored version) for downstream writes so stale holder's writes are rejected. Set lease < max job duration; add watchdog/renewal if long jobs. Under partition/pause: lock expires and another acquires (split-brain possible for work) → make jobs idempotent and safe to restart/abort. Not full consensus (Paxos/Raft) because Redis is single-node authority with failover timing; for most cron safety, lease+idempotency+fencing is sufficient.

**Deep explanation:**
Acquisition: `SET resource:cron:daily uuid NX PX 300000` (5 min lease). Token ownership: only holder knows uuid. Release Lua atomic. Watchdog: refresh EXPIRE while running if job > lease (but be careful on GC pause). Fencing: store token version in job context; when writing results to DB, require version >= current or reject. Partition: holder pauses (GC), lease expires at T+lease, new holder acquires at T'>T+lease; old holder wakes, may continue — fencing prevents corrupting state. Why not consensus: etcd/Consul Raft give stronger linearizable leases but higher latency/ops; Redis simpler, single-threaded fast. Trade-off: availability vs consistency during failover (clock assumptions small). Also consider "lock jitter", avoid indefinite holds.

**Common mistake:**
*Weak:* `SETNX` then `GET` then `DEL` without atomic check (race: holder crashes, new acquires, old thread DELs new lock).
*Correction:* Always Lua check-and-delete by token.

---
### Q92. Redlock controversy — what it guarantees/doesn't, clock assumptions, when a simpler lock is fine?

**Thought process:**
Redlock (distributed lock with multiple Redis instances) attempts consensus-like safety but has well-known critiques (Martin Kleppmann). Need to state guarantees honestly.

**Short interview answer:**
Redlock uses N independent nodes, majority votes, time drift bounds. It guarantees mutual exclusion with high probability if clock drift < small and leases respected, but it does NOT guarantee linearizability under certain timing, and failover timing can create issues. Critiques: client GC pause after acquiring but before writing, or delayed sync can violate safety. Simpler single-Redis lease is fine for most non-transactional, idempotent job coordination; use Raft-based (etcd/Consul) when you need strong consistency for external state changes with fencing criticality.

**Deep explanation:**
What it guarantees: at most one holder at a time with majority. Doesn't guarantee: that the lock holder's work happens before others see effects in a globally linearizable order without fencing. Clock assumptions: assumes roughly monotonic clocks, max drift small (e.g. < 1s) — NTP issues possible. Key risks: if a node restarts and loses lock state before persistence, it can rejoin and vote for another. Also network partitions + process pause. Kleppmann argues Redlock's safety model is flawed without version/fencing tied to external storage. When simpler is fine: single primary Redis, low contention, jobs idempotent, external side effects can tolerate at-most-once with dedupe. When prefer consensus: financial writes, cross-system atomicity. Be precise: don't claim consensus; claim lease-based mutual exclusion with trade-offs.

**Common mistake:**
*Weak:* "Redlock gives strong distributed consensus."
*Correction:* It gives a lease-based majority lock with clock assumptions, not full consensus; external fencing is still required.

---
### Q93. Worker crashes mid-job on a Redis Stream — walk through PEL, XPENDING, XAUTOCLAIM, replay, duplicates, idempotent handling?

**Thought process:**
Streams with consumer groups provide at-least-once delivery and pending lists. Crash recovery uses XPENDING/ XAUTOCLAIM to reassign pending messages.

**Short interview answer:**
When a consumer reads via `XREADGROUP`, messages move to its Pending Entries List (PEL). If worker crashes before `XACK`, those entries remain pending. A recovery process (or another consumer) can list pending via `XPENDING`, inspect idle time, and reclaim via `XAUTOCLAIM` (or `XCLAIM`). Replayed messages may be delivered again (at-least-once), so processing must be idempotent (dedupe key, version, store processed message IDs). Also handle "poison" messages (max retries, DLQ stream).

**Deep explanation:**
PEL tracks (message-id, consumer, idle time, deliveries). `XPENDING group stream [start end count] [consumer]` shows state. `XAUTOCLAIM group stream consumer min-idle-time count [start end]` atomically transfers ownership to claimant after idle > threshold. After processing, call `XACK group stream id`. Duplicates occur on crash/replay or redelivery. Idempotency: record processed IDs in Redis (e.g. `processed:{msgid}` with TTL) or in DB. Max delivery count: track via `XACK`+`XDEL` not directly; use `XPENDING` info or increment counter in app state. Poison queue: if deliveries > threshold, move to `stream:dlq` via `XADD` + `XACK` (and log). Also consider visibility timeout semantics. For exactly-once: not possible with at-least-once; aim effectively-once via dedupe + deterministic side effects.

**Common mistake:**
*Weak:* "Streams give exactly-once."
*Correction:* At-least-once delivery; duplicates expected on crash → require idempotent processing.

---
### Q94. Design a job queue on Redis Streams vs Kafka for a growing company (retention, replay, throughput, ops, migration path) — no "Streams kill Kafka" answers?

**Thought process:**
Pragmatic comparison. Both valid; choose by retention, ordering, partitioning, durability needs. Avoid hype.

**Short interview answer:**
Redis Streams: in-memory + AOF/RDB, low latency (~1ms), simple ops, consumer groups, at-least-once. Retention limited by memory (use `MAXLEN` ~approx or `XTRIM`). Great for short-lived jobs, real-time, lower ops burden. Kafka: disk-based, longer retention (days/weeks), partitions for parallelism, higher throughput for large logs, stronger durability/audit, ecosystem. Choose Kafka if need long-term replay, very high throughput (100MB/s+), many consumers with different offsets, or strict durability SLAs. Migration: start with Streams, extract to Kafka via bridge if retention/replay needs grow.

**Deep explanation:**
Throughput: Redis single-threaded core but very fast for small messages (100k-500k msgs/s typical); Kafka batched disk I/O scales higher for large payloads. Latency: Streams p99 < 1-2ms, Kafka often 5-10ms end-to-end. Retention: Streams trim by size/time via `XTRIM` (approximate MAXLEN); memory-bound. Kafka by time/size on disk (TBs). Replay: Kafka allows arbitrary offset rewind across weeks; Streams history limited by trimmed range. Ordering: Streams per stream key ordered; Kafka per partition ordered. Ops: Redis simpler (single node/cluster), Kafka needs brokers/zookeeper/KRaft + replication management. Failure: Redis AOF fsync every second gives reasonable durability; Kafka ack=all stronger for critical logs. Migration path: dual-write to both initially, or outbox → stream → Kafka connector. No silver bullet.

**Common mistake:**
*Weak:* "Redis Streams replace Kafka for everything."
*Correction:* Different trade-offs (memory vs disk retention, scale, ecosystem). Be balanced.

---
### Q95. Exactly-once in stream processing — why it's not real, what effectively-once requires (dedupe store + deterministic side effects)?

**Thought process:**
"Exactly-once" is a common claim but practically impossible without strong coordination across systems. Aim for effectively-once semantics.

**Short interview answer:**
Exactly-once delivery+processing is not achievable in distributed systems with crashes/retries without idempotency keys and transactional outbox/idempotent consumers. Instead, design for at-least-once delivery + idempotent processing = effectively-once. Requirements: dedupe store (processed message IDs with TTL), deterministic side effects or idempotent operations, and transactional boundaries (e.g. write to DB + mark processed in same transaction, or outbox pattern).

**Deep explanation:**
Network failures mean ack can be lost: consumer processes message, crashes before ACK → redelivered. Producer retries can create duplicates. Redis Streams/Kafka provide at-least-once. To achieve effectively-once: (1) assign unique message IDs (or use producer keys), (2) maintain processed set in durable store (DB) with uniqueness constraint, (3) make operations idempotent (e.g. UPSERT, INSERT ... ON CONFLICT), (4) avoid non-idempotent side effects (email) without de-duplication/idempotency keys. Deterministic processing helps for stateful streaming. Also "exactly-once" in Kafka transactions refers to producer/consumer atomicity in Kafka scope, but external side effects still need care. Don't overstate.

**Common mistake:**
*Weak:* "Redis Streams/Kafka guarantee exactly-once."
*Correction:* Guarantee at-least-once; effectively-once requires application-level deduplication + idempotent side effects.

---
### Q96. Cache stampede during a Black Friday flash sale — layered defenses (jitter, lock/singleflight, SWR, background refresh, warming) with reasoning?

**Thought process:**
TTL expiry at same time causes thundering herd to DB. Need layered defenses balancing freshness vs load.

**Short interview answer:**
Defenses: (1) TTL jitter (randomize ±10-30% of TTL) to spread expirations, (2) request coalescing (singleflight/in-process lock) so only one request refreshes key on miss, (3) "stale-while-revalidate" (SWR) — serve stale if available while refreshing in background, (4) background refresh before expiry (e.g. refresh at TTL*0.8), (5) cache warming for known hot keys pre-sale, (6) circuit breaker + backpressure. Layered: jitter prevents synchronization, singleflight prevents herd on miss, SWR prevents blocking.

**Deep explanation:**
Jitter: instead of TTL=300s for all, use 270-330s. Singleflight: when key misses, first goroutine acquires lock, fetches from DB, populates cache; others wait and get same value. Redis-based distributed lock (SETNX+Lua) if cross-process. SWR: store value with `stale_until` and `refresh_at`; if refresh_at passed, serve stale and trigger async refresh (with coalescing). Background refresh: proactive, reduces misses. Warming: load top N SKUs before peak (e.g. via script). Also negative caching for 404s. For flash sale, expect 10x traffic: DB must be indexed, queries cheap. Monitor cache hit ratio, DB QPS, p99. Note: SWR trades staleness (e.g. up to 30s) for availability — acceptable for product listing, not for inventory/pricing in some cases.

**Common mistake:**
*Weak:* "Just increase TTL."
*Correction:* Long TTL increases staleness; need coordinated miss prevention + jitter.

---
### Q97. Systematic cache invalidation architecture across 50 microservices (owner-per-key, versioned keys, outbox + pub/sub or ChangeDataCapture, bounded staleness)?

**Thought process:**
Cross-service invalidation is hard: dual-writes fail. Need clear ownership, versioning, and reliable eventing.

**Short interview answer:**
Establish owner-per-key (each entity owned by one service). On write, owner updates source of truth + writes to outbox in same DB transaction. Outbox relay publishes change events (or CDC captures WAL). Consumers invalidate local caches via pub/sub (Redis PUBLISH) or direct key deletion/version bump. Use versioned keys (`v2:entity:id`) for safe rollouts. Accept bounded staleness where strong consistency not required; for critical (balances), prefer read-through with version check or event-driven + read-after-write from primary.

**Deep explanation:**
Owner-per-key prevents conflicting writers. Outbox + relay (Debezium/transactional outbox service) guarantees at-least-once event delivery on commit. Redis pub/sub is fire-and-forget (not durable); for 50 services, use durable channel (e.g. Kafka) or tolerate missed messages with periodic reconciliation. Versioned keys: bump version on write → clients read new key; old keys expire via TTL (no need to broadcast delete to all). Alternatively, store version in cache and in entity. Bounded staleness: define max staleness (e.g. 5s) per entity class. For 50 services, avoid N^2 invalidation calls; use topic per entity type or fan-out. Also consider "cache-aside + TTL only" for low-value data. Monitoring: track lag, dropped events. Critical reads: read from owner DB or use "read-after-write" consistency (stick to primary). Never do synchronous cross-service cache deletes on write path.

**Common mistake:**
*Weak:* "Every service PUBLISHes invalidation on write" without ownership/transactions.
*Correction:* Dual-writes without outbox cause lost invalidations on crash.

---
### Q98. Transactional outbox + event-driven invalidation — how it works, why dual-write without it breaks, at-least-once consequences?

**Thought process:**
Dual-write (update DB, then delete from cache) is not atomic; crash between them leaves stale cache. Outbox ensures event emitted only on committed DB change.

**Short interview answer:**
In same DB transaction: write entity change + insert event row into `outbox` (payload, type, key). After commit, relay (polling or CDC) publishes event to message broker/Redis pub-sub. Consumers on receiving event invalidate/update caches. Dual-write without outbox breaks on process crash, Redis down, or network error after DB commit but before cache write (stale). At-least-once delivery means consumers may receive same event twice → invalidations must be idempotent (deleting same key twice is fine; version bump idempotent if version monotonic).

**Deep explanation:**
Transaction ensures outbox row only exists if DB change committed. Relay guarantees delivery when event available. This is the standard to avoid lost messages. At-least-once: event replayed → consumer does `DEL` or `HSET` again; safe if idempotent. Also use event IDs to dedupe. Why not cache-first? Write-through can help but still cross-system. Redis pub/sub is not durable; if subscriber offline during publish, message lost → pair with outbox+durable broker for critical paths, or use key-based reconciliation (periodic scan by version). Consequences: at-least-once means your invalidation handler must be re-runnable; also ordering: events for same key must be processed in order (partition by key).

**Common mistake:**
*Weak:* "Update DB then DEL cache" as sufficient.
*Correction:* Not atomic; crash between → stale. Use transactional outbox for reliable invalidation.

---
### Q99. When TTL alone is acceptable vs when it is dangerous (pricing, balances, permissions)?

**Thought process:**
TTL is eventual expiration; acceptable for non-authoritative, display-only data. Dangerous for correctness-critical state.

**Short interview answer:**
TTL alone acceptable for: product lists, search results, CDN-cached pages, recommendations, counts where approximate is fine, non-sensitive metadata. Dangerous for: account balances, pricing at checkout, inventory availability affecting orders, permissions/authorization, payment state, idempotency keys for critical ops. For dangerous cases, prefer explicit invalidation (event-driven), versioned reads, or read-through from authoritative source with validation. If using TTL, combine with short TTL + staleness bounds + server-side reconciliation.

**Deep explanation:**
Example: pricing cached with 10m TTL during sale → customer sees old price, charged new? Or vice versa. Balances: could allow overdraft if reading stale. Permissions: revoked access remains valid until TTL. Mitigations: for pricing/checkout, read authoritative price at transaction time; cache for display only. For balances, never trust cached balance for debit — read DB balance with constraints (e.g. balance >= amount) in transaction. Permissions: use short TTL (seconds) or explicit invalidation on revoke. Also consider negative caching carefully. Principle: cache is a performance optimization, not a source of truth for decisions that affect money/compliance. Document staleness tolerance per entity.

**Common mistake:**
*Weak:* "Set TTL=1h for everything."
*Correction:* TTL ≠ consistency; treat correctness-critical data as non-cacheable for writes/authoritative reads.

---
### Q100. Multi-level cache design (CDN → in-process L1 → Redis → PG) — latency wins vs stale-data cost and invalidation fan-out?

**Thought process:**
Each level closer to client = lower latency but smaller scope, harder invalidation, more staleness.

**Short interview answer:**
Levels: CDN (edge, static, 0-10ms), L1 in-process per service (microseconds), Redis (shared, 1-2ms), Postgres (authoritative, 5-20ms). Latency win large for hot paths; stale-data cost rises at outer levels. Invalidation: CDN purging slow/bulk, L1 per-instance (broadcast or TTL), Redis shared (pub/sub or DEL), PG source. Design by volatility: static → CDN, semi-dynamic → L1+Redis with event invalidation, critical → read-through to PG.

**Deep explanation:**
Latency numbers: L1 ~0.01ms, Redis ~1ms, PG ~10ms → factor 1000x. For 1M QPS, avoiding network helps. But L1 has per-server staleness (n instances see different versions until invalidated). CDN has global staleness. Invalidation fan-out: updating one entity → must invalidate L1 on all app pods (e.g. via Redis pub/sub "invalidate key" or HTTP endpoint), Redis, CDN (harder). Trade-offs: stronger consistency → push invalidation down to all levels (costly); weaker → use TTLs. For product catalog display: L1+Redis acceptable with 5m TTL; for cart totals: avoid L1 caching or very short TTL. Also L1 memory per instance limited. Warming L1 on startup. Consider "request coalescing" across levels. Cost of staleness: user-visible (bad UX) vs business (pricing error). Choose per use case.

**Common mistake:**
*Weak:* "Cache everything at every level."
*Correction:* More levels = more invalidation complexity and staleness windows; add only where measured latency matters.

---
### Q101. In-process L1 cache pitfalls (per-server staleness, stampede into Redis, sizing, TTL budgeting)?

**Thought process:**
L1 is fast but isolated. Common traps: inconsistent views across instances, and on expiry many instances stampede Redis/DB simultaneously.

**Short interview answer:**
Pitfalls: (1) Per-server staleness — each instance has its own copy; after write, other N-1 instances serve stale until invalidated/expire. (2) Stampede into Redis — if all instances expire key at same time, each does cache-aside to Redis/DB. (3) Sizing — unbounded L1 causes OOM per pod; use small capacity (e.g. 10k keys) with admission. (4) TTL budgeting — don't use same long TTL as shared cache; prefer shorter or adaptive. Mitigations: jittered TTLs, in-process singleflight, SWR, explicit pub/sub invalidation to all instances, and track staleness tolerance.

**Deep explanation:**
Staleness window: can be seconds even with events if broadcast fails. For user-specific data (cart), stickiness helps; for shared (catalog), bounded staleness acceptable. Stampede: e.g. 100 pods * 1000 req/s hitting same expiring key → 10^5 concurrent fetches. Use singleflight per key in each process (Go `singleflight`, similar in TS with promise coalescing). Also "refresh ahead". Sizing: use LRU/ARC with max memory (e.g. 256MB) and key count limits. TTL budgeting: L1 TTLs typically shorter (30s-5m) than Redis (5m-1h) to reduce staleness; or align with invalidation. Also watch heap usage, GC impact. Avoid L1 for critical consistency (balances). Consider "read-through" with versioning.

**Common mistake:**
*Weak:* "Add L1 everywhere without invalidation strategy."
*Correction:* L1 without cross-instance invalidation amplifies staleness; combine with jitter + singleflight.

---
### Q102. Redis persistence decision — cache-only workload vs stateful workload, RDB+AOF settings, recovery time, data-loss window numbers?

**Thought process:**
Cache-only: can lose all data on restart (acceptable if DB can repopulate). Stateful (sessions, locks, counters, streams): need durability aligned to RPO.

**Short interview answer:**
Cache-only: `save ""`, `appendonly no` (or minimal) — maximize performance, accept full loss on crash; rely on cache warmup. Stateful: use AOF with `appendfsync everysec` (RPO ~1s data loss max) and/or RDB snapshots for faster restarts. RDB+AOF gives both: AOF for durability, RDB for recovery speed. Tune: snapshot frequency (e.g. `save 900 1 300 10 60 10000`), AOF rewrite, `auto-aof-rewrite-percentage`. Recovery time: RDB faster to load large datasets; AOF larger, replay slower. Quantify: 10GB RDB loads ~10-30s, AOF depends on size.

**Deep explanation:**
Data-loss window: `appendfsync always` → 0 (but slow), `everysec` → up to 1s, `no` → OS-dependent (potential seconds lost). For sessions: 1s loss acceptable? Usually yes. For payment idempotency state, better durable (AOF everysec) or store in DB. Cache-only: save memory/IO, restart means cache miss storm → prepare warmup + DB protection. Replicas: persistence on primaries matters for failover durability. Also `aof-use-rdb-preamble` speeds AOF rewrites/reloads. Check `rdb_last_save_time`, `aof_last_bgrewrite_status`. Never assume durability of pub/sub (fire-and-forget). For critical state, prefer DB as source of truth with Redis as cache/lease holder.

**Common mistake:**
*Weak:* "Always enable AOF always" or "never persist."
*Correction:* Choose by workload; quantify RPO/RTO and performance impact.

---
### Q103. Replication lag breaks read-after-write — detect it, route reads, monotonic reads, use cases that can tolerate it?

**Thought process:**
Async replication means replica lags primary; reading from replica after write gives stale data. Need strategies.

**Short interview answer:**
Detect lag: `INFO replication` (`master_repl_offset`, `slave_repl_offset`, `repl_backlog`) or `ROLE`, measure seconds_behind_master. Route reads: for read-after-write consistency, read from primary (or route by session/user to primary for short window). For "read-your-writes", use session stickiness to node that saw write, or versioned keys. Monotonic reads: ensure same client reads from same replica (or same shard) to avoid going forward/backward. Tolerate lag when: analytics, counters not immediately critical, feeds, recommendations (eventual consistency fine).

**Deep explanation:**
Seconds_behind_master can be misleading under network stalls, but useful. Also track replication offset diff. Read routing: e.g. after user writes profile, next reads go to primary for 5-10s, else to replicas. Or include read-replica only for non-critical GETs. Monotonic reads prevent "time travel": client reads v2 then later v1 if routed to lagging replica. Solutions: consistent hashing by client id to replica, or use "read-after-write" token. Cross-region: lag higher (50-150ms RTT). For sessions: if writing session, subsequent reads must see it → primary or sticky. For likes count: lag 1s fine. Measure actual lag in prod: alert if > 500ms or > 2s. Also consider "sync" replication not default in Redis.

**Common mistake:**
*Weak:* "Send all reads to replicas" without handling read-after-write.
*Correction:* Async replication breaks read-after-write; explicitly route based on consistency needs.

---
### Q104. Primary fails during peak — Sentinel/Cluster failover timeline, split-brain risk, client retry storms, what the app must do?

**Thought process:**
Failover is a critical window: detection, election, promotion, client redirection. Many things can go wrong (split-brain, thundering retries).

**Short interview answer:**
Timeline (typical): node down detected (ping + timeout, ~1-2s), Sentinel votes (quorum, ~1-3s), promote new primary, update config (~seconds total). RTO often 10-30s configurable. Split-brain: if network partitions, two primaries possible if quorum lost/misconfigured — Redis protects via epoch/config; but application must be idempotent. Client retry storms: on `MOVED/ASK/READONLY` or connection errors, all clients retry aggressively → thundering herd. App must use exponential backoff + jitter, connection pooling with circuit breaker, and limit max retries. Also "retry after failover" awareness.

**Deep explanation:**
Sentinel: `down-after-milliseconds`, `failover-timeout`, `parallel-syncs` affect timing. Cluster: gossip + failure detection faster. During failover, writes to old primary (if partitioned, still thinks primary) are lost if not replicated — that’s unavoidable without sync. Split-brain risk reduced by requiring majority/quorum and `min-slaves-to-write`. App responsibilities: handle `READONLY` errors (writes rejected), reconnect on `MOVED`, use backpressure. Retry storms: exponential backoff (e.g. 50ms*2^n + jitter) cap at 2-5s, and token-bucket per host. Also "health check" before retry. Prepare for partial degradation: return 503 with `Retry-After` if overloaded. Practice failover drills (GameDays). Monitor `failover_count`, promoted slaves.

**Common mistake:**
*Weak:* "Clients just retry immediately on error."
*Correction:* Immediate retries cause retry storms; require backoff+jitter and circuit breakers.

---
### Q105. Redis outage at 3 AM — runbook: cache hits off, DB protection (pool limits, timeouts, shed load), what never to do (unbounded retries), recovery/warming?

**Thought process:**
Incident response: fail safe, protect downstream DB, communicate, recover gradually.

**Short interview answer:**
Immediate: detect via alerts (latency/errors), switch to degraded mode (serve stale where allowed or 503). Cache hits off → all traffic to DB; enforce DB connection pool limits, query timeouts (e.g. 2-5s), and load shedding (queue size caps, shed low-priority). Never do unbounded retries or infinite loops; use circuit breakers and exponential backoff. Recovery: bring Redis back, watch replication, warm critical keys (top N), ramp traffic gradually (canary), monitor hit ratio and DB load. Post-incident: write RCA.

**Deep explanation:**
DB protection: without limits, 1M cache-miss QPS can DDoS DB (connection exhaustion, lock contention). Set `max_connections`, statement timeouts, pgbouncer. Shed load: return 503 "Service Unavailable" with Retry-After for non-critical or when DB saturated. Bulkhead by endpoint. Warming: identify hot keys from logs/metrics before outage or pre-warm top products. Also negative caching to avoid repeated misses for missing keys. Avoid "thundering herd" on recovery: use gradual ramp or SWR. Runbook must be explicit (commands, metrics, contacts). Test: chaos engineering for Redis outage. Logging: structured, no PII. Also consider fallback cache? Rare.

**Common mistake:**
*Weak:* "Let all requests hit DB unthrottled."
*Correction:* Cache outage becomes DB outage without explicit throttling/shedding and bounded retries.

---
### Q106. Monitoring/alerting for Redis — metrics list (hit ratio, evictions, fragmentation, p95/p99 latency, connected clients, replication lag, ops/sec, blocked clients, hot keys), what page-worthy thresholds are?

**Thought process:**
Observability needs RED/USE style + Redis-specific. Alert on symptoms (user impact) not just noise.

**Short interview answer:**
Key metrics: hit ratio (`keyspace_hits/(hits+misses)`), evictions (`evicted_keys`), mem fragmentation ratio (`mem_fragmentation_ratio`), latency (p50/p95/p99 command latency, use `LATENCY LATEST/HISTOGRAM`), connected clients, maxclients, replication lag (`seconds_behind_master`), ops/sec (`instantaneous_ops_per_sec`), blocked clients (`blocked_clients`), hot keys (via `redis-cli --hotkeys`, `MONITOR` sampling), memory (`used_memory`, `used_memory_rss`). Page-worthy: Redis p99 > 10ms sustained, hit ratio < 90% (for cache workload), evictions > 0 for >5min (capacity), fragmentation > 1.5 sustained, replication lag > 2s, blocked clients > 100 sustained, connected clients near maxclients, OOM errors, failover events.

**Deep explanation:**
Hit ratio: track per route; < 95% may indicate TTL/invalidity issues. Evictions: any non-zero sustained means under-provisioned (or bad policy). Fragmentation: > 1.5 suggests allocator fragmentation; > 2.0 investigate. Latency: command p99 > 5-10ms often indicates slow commands (KEYS, SMEMBERS large set), network, or CPU. Blocked clients: waiting on BLPOP/BRPOP/XREAD — can indicate consumer lag. Hot keys: detect via sampling (Redis doesn't expose natively in all versions; use `hotkeys` script or `MONITOR` with sampling in prod carefully). Also track `rejected_connections`, `rdb_last_bgsave_status`. Alerts: symptom-based (p99 error budget burn) + cause-based. Dashboards: RED (Rate, Errors, Duration). Correlate with app metrics.

**Common mistake:**
*Weak:* "Alert only on memory usage."
*Correction:* Focus on user-impacting (latency, hit ratio, failover) plus leading indicators (evictions, lag).

---
### Q107. p50 vs p95 vs p99 — why p99 dominates user experience for Redis-backed APIs, coordinated omission awareness?

**Thought process:**
Tail latencies affect worst-case user experience (outliers). Coordinated omission means measured latencies under-represent true tail under load.

**Short interview answer:**
p50 (median) is typical, p95 95% faster, p99 1% slowest — but for high-traffic APIs, p99 requests accumulate and dominate perceived slowness (e.g. 100 requests per page → 63% chance hit at least one p99). Coordinated omission occurs when load generator doesn't issue next request until previous completes (hides queuing under saturation), underestimating p99. For Redis-backed APIs, keep p99 Redis < 2-5ms and end-to-end p99 < 100-200ms.

**Deep explanation:**
Example: p99 100ms, p50 10ms — many users experience 100ms on some calls. Coordinated omission: if client waits, measured tail looks better than reality; use open-loop load testing (maintain constant arrival rate) or tools that correct. Redis latency: even 1ms outliers hurt if called in serial (N calls → sum of tails). Mitigate: parallelize calls, use timeouts (e.g. 1-2ms per Redis op), circuit breakers, hedging (send to replica on timeout with care), and connection pooling. Monitor with `redis-cli --latency`, `LATENCY DOCTOR`, and app-level histograms. Also track error budget burn on p99. For user-facing flows, optimize tail, not just median.

**Common mistake:**
*Weak:* "Optimize for average latency."
*Correction:* p99 drives UX; test with open-loop/load generators aware of coordinated omission.

---
### Q108. KEYS vs SCAN vs pipelined batch reads on a 50M-key production dataset — cost of each?

**Thought process:**
KEYS is O(N) and blocks Redis (single-threaded) — dangerous on large datasets. SCAN is incremental, non-blocking. Batch reads via pipelining efficient for known key lists.

**Short interview answer:**
KEYS `*` scans entire keyspace in one pass → blocks for seconds on 50M keys, causes latency spikes for all clients. SCAN iterates cursor-based in chunks (`COUNT`), returns subset, doesn't block long; use in production for inspection. For batch reads of known keys, use `MGET` (or pipelined `GET`/`HMGET`) — much more efficient than per-call round trips; pipeline N ops in one TCP round trip, server executes sequentially but faster overall.

**Deep explanation:**
Cost: KEYS touches every key in dictionary at once (CPU+memory traversal) → Redis unavailable during scan. SCAN O(1) per call, amortized O(1) over all keys; may return duplicates (rare with recent Redis), must iterate until cursor 0. Production: never run KEYS; use SCAN with reasonable COUNT (e.g. 1000-10000). For 50M keys, SCAN with COUNT 5000 takes ~10k calls, each cheap, no long block. Pipelining: batch 1000 GETs in one pipeline → 1 RTT vs 1000 RTTs; reduces latency and network overhead. Also use `MGET` when applicable. Avoid `SMEMBERS` on huge sets (use `SSCAN`). For hot keys analysis, prefer `redis-cli --hotkeys` or sampled `MONITOR`. Monitor `commandstats` for slow commands.

**Common mistake:**
*Weak:* "Run KEYS * to debug in prod."
*Correction:* Blocking operation on large keyspace; use SCAN instead.

---
### Q109. When NOT to use Redis (large objects, long-term durable storage, complex queries/relations, strict audit logs, unlimited growth) — pick something else?

**Thought process:**
Redis is optimized for in-memory ops; not a general-purpose DB for all cases.

**Short interview answer:**
Avoid Redis when: (1) Large objects (multi-MB blobs) — memory expensive, network heavy, replication/copy slow; use object store (S3) + metadata in DB. (2) Long-term durable storage with strict durability/compliance — Redis persistence optional; use RDBMS/object store with backups. (3) Complex queries/relations (joins, ad-hoc SQL, full-text) — use Postgres/MySQL/ElasticSearch. (4) Strict audit logs needing immutability, retention years — use append-only log store (Kafka/S3/ledger). (5) Unlimited growth with no eviction acceptable — memory finite, cost linear; use disk-based. Also if you need multi-document transactions across arbitrary entities, Redis transactions (MULTI/EXEC) limited.

**Deep explanation:**
Memory cost: 1GB RAM roughly more expensive than 1GB disk; large objects waste cache working set. Replication: transferring 1MB values creates replication backlog. Eviction: if you can't evict, don't use cache. For audit: need tamper-evidence, WORM storage. For complex relations: Redis data structures (sets/zsets) help but no query planner. Example: user feeds better in specialized store? Or order history with queries → DB. Also if workload is write-heavy with no reads, Redis may not help. Choose: S3 for blobs, Postgres for relational+ACID, Elasticsearch for search, Kafka for logs, Cassandra/DynamoDB for wide-column at scale. Be pragmatic: use right tool.

**Common mistake:**
*Weak:* "Redis can do everything if scaled."
*Correction:* Memory-bound, limited query model; pick purpose-built stores for large blobs/complex queries/audits.

---
### Q110. Redis vs Memcached at scale (multi-threading, data structures, eviction, replication, why Memcached still fits simple pure-cache)?

**Thought process:**
Both in-memory caches; differences matter at scale.

**Short interview answer:**
Redis: single-threaded core (I/O multiplexing), rich data structures (strings, hashes, lists, sets, zsets, streams, bitmaps, HyperLogLog), built-in replication, persistence, Lua, Cluster. Memcached: multi-threaded (scales CPU for simple get/set), simpler key-value, no persistence/replication built-in (client-side or external), slab allocator. Memcached still fits pure-cache with simple strings, very high throughput on multi-core for get-heavy workloads, lower memory overhead for simple values. Choose Memcached if pure K/V, no need for data structures/persistence/replication; choose Redis for richer semantics, HA, durability needs.

**Deep explanation:**
Multi-threading: Memcached can use multiple cores for parallel ops on different connections; Redis 6+ I/O threads help with networking but command execution mostly single-threaded (avoids locking). For simple GETs, Memcached often achieves higher ops/sec on large boxes. Data structures: Redis enables atomic multi-field ops (HINCRBY) without client-side logic. Eviction: both LRU-like; Redis has volatile/allkeys policies. Replication: Redis native async; Memcached needs third-party. Memory: Memcached slab-based can have slab calcification; Redis jemalloc. At scale (1M QPS simple), Memcached horizontal is straightforward. Why still fits: lower complexity, predictable for pure cache, less features to misconfigure. But modern apps often need Redis features (locks, rate limits, streams). Context matters.

**Common mistake:**
*Weak:* "Redis is always better than Memcached."
*Correction:* Memcached simpler/faster for pure string caching; Redis richer for real systems.

---
### Q111. Redis vs Kafka — persistence, consumer groups, replay, retention, throughput, ops complexity, when each wins?

**Thought process:**
Different purposes (cache/fast data structures vs durable event log). Compare pragmatically.

**Short interview answer:**
Redis (Streams): in-memory + AOF/RDB, consumer groups, at-least-once, replay limited by trimmed history (memory-bound), low latency (1ms), simpler ops. Kafka: disk-based log, consumer groups with offset commits, full replay from offset (retention days/weeks), higher throughput for large messages/batches, partitioned parallelism, more complex ops (brokers/KRaft). Redis wins for short-lived queues, real-time processing, low-latency work distribution, and when memory is acceptable. Kafka wins for event sourcing, audit logs, long-term retention, backfill/replay across consumers, and very high sustained throughput.

**Deep explanation:**
Persistence: Kafka durable by default (replicated logs); Redis optional. Retention: Kafka configurable by size/time independent of memory. Replay: Kafka arbitrary offsets. Throughput: Kafka optimized for sequential disk I/O + batching. Ops: Redis 1-3 nodes easy; Kafka needs cluster care. Ordering: per-partition (Kafka) vs per-stream (Redis). Also Redis pub/sub fire-and-forget. When to pick: job queue with 10min visibility → Streams fine; event store for analytics replay 30 days → Kafka. Hybrid: outbox → Kafka for durable events, Redis for hot paths. Avoid "either/or" absolutism.

**Common mistake:**
*Weak:* "Use Redis Streams for all eventing."
*Correction:* Long-term retention/replay and high throughput favor Kafka; Streams best for ephemeral low-latency queues.

---
### Q112. Redis vs PostgreSQL for session state — durability expectations, restart consequences, backfill strategy?

**Thought process:**
Sessions: user auth context, cart. Trade-offs between speed and durability.

**Short interview answer:**
Redis: ultra-fast (1ms), easy TTL expiration, supports large concurrent sets. But in-memory; on restart without AOF/RDB, sessions lost (if not replicated/persisted). Postgres: durable, queryable, transactional, but higher latency (5-20ms) and more load under 1M QPS. For most web apps, Redis is fine for sessions with `appendfsync everysec` + replication, or accept short logout window. For banking/compliance requiring strict durability, PG (or both). Backfill: sessions created on login; on Redis loss, users may be logged out — acceptable if session TTL reasonable; don't backfill from PG unless tracking sessions there (extra write overhead).

**Deep explanation:**
Durability expectations: typically "eventual" acceptable — users re-login after rare restart. Restart consequences: cache miss → if app checks Redis first, treats as no session → redirect to login. Mitigate by persisting (AOF) or using sticky sessions? No. Backfill strategy: lazy (recreate on next login/activity) vs proactive (if you persist session records in PG, reload active sessions with TTL>now). But reloading 10M sessions on startup is I/O heavy. Better: accept loss, rely on refresh tokens, keep session TTL short (e.g. 15-30min). Also consider "remember me" long-lived tokens stored in secure httpOnly cookie (signed) avoiding server state. Hybrid: signed tokens (stateless) eliminate session store needs; or PG for critical sessions.

**Common mistake:**
*Weak:* "Postgres is too slow for sessions."
*Correction:* Depends on scale; PG fine for moderate QPS. Redis preferred for high scale + TTL semantics.

---
### Q113. Design feed generation (Instagram-style) with sorted sets/lists — fan-out on write vs read, memory bounds, TTLs?

**Thought process:**
Feed scaling: following graph large. Fan-out on write (push posts to followers' feeds) vs read (pull from follows). Memory vs freshness.

**Short interview answer:**
For small follower counts (<1k), fan-out on write using lists/sorted sets per user feed (`feed:{uid}`) is efficient (push post id with timestamp score). For celebrities (millions followers), fan-out on write is expensive; use fan-out on read (query follows + recent posts) or hybrid (push to active followers only). Use sorted sets (ZADD) with score=post time for pagination (ZREVRANGE). Memory bounds: cap feed size per user (e.g. 1000-2000 recent posts) via `ZREMRANGEBYRANK` or `LTRIM`; also TTL on old feeds? Or trim. Add posts to global pool, per-feed stores references only.

**Deep explanation:**
Fan-out on write: O(F) per post where F followers → celebrity post costs millions of writes. Memory: 10M users * 1000 post refs * (8+8 bytes) = 160GB. Expensive. Fan-out on read: fetch follows list (small), then query posts from those users (indexed in DB/Redis) → O(F_followed + results) per request, more read load. Hybrid: for normal users write fan-out; for high-F users, don't fan-out, serve on read by merging. Also use "timeline" as sorted set of post ids from self+followed with time. Pagination via ZREVRANGE with cursor. TTLs: not necessary if capped; old entries trimmed. Sharding feeds by uid. Also consider "pull-based" with Redis lists less flexible for time-based. Denormalization cost vs read cost. Measure for target scale.

**Common mistake:**
*Weak:* "Always fan-out on write."
*Correction:* Doesn't scale for super-users; need hybrid strategy with memory caps.

---
### Q114. Design a leaderboard (sorted set) — ZADD/ZRANGE/ZREVRANGE, periodic scoring decay, pagination, memory at 100M players?

**Thought process:**
Sorted sets perfect for rankings (O(log M) per update). Decay and scale considerations.

**Short interview answer:**
Use Redis sorted set `lb:global` with member = player_id, score = current score. `ZADD` on score change, `ZREVRANGE lb:global 0 9 WITHSCORES` top 10, `ZRANK` for user rank. Pagination by rank ranges. For 100M players, each update O(log(100M)) ~27 ops, 10k updates/sec trivial. Memory: 100M entries * (say) 8+8+8=24 bytes overhead ~ 2.4GB acceptable. For decay: periodic (e.g. hourly cron) apply decay factor via `ZREMRANGEBYSCORE` to remove inactive or multiply scores? But updating all 100M in one pass blocks; instead use "time-based decay" on read (score = base_score * exp(-lambda*(now-last))) or maintain separate decay epoch and recompute on access, or bucket by time windows.

**Deep explanation:**
Decay approaches: (1) Lazy decay on read — compute effective score at query time (store base + timestamp), avoids writes. (2) Active decay — iterate in batches with SCAN-like over sorted set (use ZRANGEBYSCORE ranges) and ZADD with new scores; spread over time. (3) Periodic reset windows (daily/weekly) — create new key `lb:2026-10-08`. Lazy is common to avoid blocking. Pagination: use rank-based (stable) or score+member cursor for large offsets. For 100M, ZRANK is O(log M); deep pagination (offset 10M) expensive — prefer cursor. Also consider sharding leaderboards by region/game mode. Memory ~ 2-3GB, fine. Expire old inactive members? If player leaves, ZREM. Monitor `used_memory`, ops.

**Common mistake:**
*Weak:* "Multiply all scores in one ZINTERSTORE/ZADD pass."
*Correction:* Bulk update of 100M entries blocks Redis; use lazy decay or batched incremental updates.

---
### Q115. Design URL shortener with Redis (counter vs hash, base62, collision thought, TTL, redirect hot path)?

**Thought process:**
Shortener: bijection short code → long URL. Need uniqueness, high redirect QPS.

**Short interview answer:**
Use Redis INCR on global counter `short:url:counter` to generate sequential ID (or Snowflake), encode to base62 for short string. Store mapping `short:url:{code}` → long URL in Redis (string) with optional TTL. Also store reverse `url:long:{hash}` to prevent duplicates? For same long URL, can return existing code. Collision: with base62 (62^7 ~ 3.5e12) and sequential IDs, collision impossible; if random, need to check. Redirect hot path: just GET by code → very fast (1ms), can be cached at CDN/L1 for popular links. Use 301/302 redirects. For scale, use Cluster sharding by code hash.

**Deep explanation:**
Counter: single counter guarantees uniqueness, easy; in Cluster, use a dedicated counter node or hash tags? Or generate in batches (allocate block of IDs per app instance to avoid INCR contention). Hash-based: store long URL hash to find existing. Collision handling: if random (e.g. nanoid), generate, SETNX — if fails retry. Sequential is monotonic (leaks count) but short. TTL: for temporary links set EXPIRE. Redirect: return 302 for temporary, 301 permanent (but CDN/browser cache). Hot links: 1M redirects/sec → L1 cache at edge/app. Memory: 10M links * (say) 7 chars code + 200 chars URL + overhead ~ 250 bytes + 50 = 300 bytes → 3GB. Persistence: AOF if need durability across restarts (or DB as source of truth). Also consider custom domain, analytics (click counts) via INCR on separate key. Security: prevent abuse (rate limit creation).

**Common mistake:**
*Weak:* "Use MD5 hash of URL as code" (collisions + long).
*Correction:* MD5 32 hex chars long; use base62 of ID; handle collisions if random generation.

---
### Q116. Design presence/online-user tracking (SADD/SREM + heartbeat TTL + periodic cleanup) for 1M concurrent users?

**Thought process:**
Track "online now" set with expiry on heartbeat. Need to scale to 1M concurrent, accurate "last seen", handle disconnects.

**Short interview answer:**
Use Redis set `presence:online` with SADD on connect/heartbeat, SREM on disconnect. Also use per-user key `presence:user:{uid}` with EXPIRE (e.g. 30-60s) updated on heartbeat (PUTEX/EXPIRE). To get online count: SCARD (fast). For "who is online", SMEMBERS on set (if small) or SSCAN. For 1M users, SMEMBERS returns 1M values (large response) — avoid in prod; use count + sampling or maintain separate counts. Periodic cleanup: when EXPIRE fires, key gone; also sync set by removing members whose per-user key expired (e.g. background job using SSCAN + EXISTS) to keep set consistent with TTLs.

**Deep explanation:**
Heartbeat: client sends every 15-30s (less than TTL) to refresh `presence:user:{uid}` with EXPIRE. On app-level disconnect (websocket close), call SREM + DEL. But abrupt disconnects (network) miss SREM → set accumulates stale entries. Solution: per-user TTL keys are source of truth; periodically reconcile set: iterate online set members via SSCAN, check EXISTS `presence:user:{uid}`; if false SREM. Do this in batches during low traffic. Scaling: 1M heartbeats every 30s = ~33k ops/sec trivial. For presence lists, paginate via SSCAN. Also consider sorted set with score=last_seen timestamp for "recently online". Pub/sub to broadcast presence changes if needed (but fire-and-forget). Cluster: shard by uid. Memory: 1M entries * (say) 8+8 bytes = 16 bytes ~ 16MB small.

**Common mistake:**
*Weak:* "Just use SADD on login, SREM on logout."
*Correction:* Network drops miss SREM; must use TTL + periodic reconciliation.

---
### Q117. Design notification system — stream as durable queue, per-user grouping, backpressure, ACK semantics?

**Thought process:**
Notifications: fan-out to users, need delivery tracking, backpressure under load.

**Short interview answer:**
Use Redis Streams as durable queue per notification type or single stream `notifications:stream`. For per-user delivery, can fan-out: for each user add to their own stream `user:{uid}:notifs` (careful with memory for large fan-out) or use consumer groups per user? Better: write to global stream, consumers read by user filter or maintain per-user pending? Or use sorted sets/lists per user mailbox with capped size. For high fan-out, push to Kafka then consume per-user. Backpressure: limit stream length via `MAXLEN`, cap per-user mailbox (e.g. 1000), use ACK required. ACK semantics: consumer reads via XREADGROUP, processes (e.g. send push/email), then XACK. On crash, pending messages redelivered (at-least-once). Track delivery status (sent/read) in DB. 

**Deep explanation:**
Global stream: `XADD notifications MAXLEN ~1000000 * payload` with user_id field. Consumers (workers) read and route to user channels; or have per-user consumer groups? Not efficient for 1M users. Alternative: per-user mailbox stream `notif:{uid}` with MAXLEN (e.g. 200) to bound memory; when notification created, `XADD` to each follower's mailbox (fan-out on write) — again celebrity problem. Hybrid: for active users push, for others pull. Backpressure: if user offline, don't grow mailbox infinitely (trim). ACK: per message id; pending entries in PEL. Poison messages: retry with backoff, move to DLQ after N attempts. Also consider batching. Memory: capped per user avoids unbounded growth. Durability: AOF everysec. For strict delivery guarantees, pair with DB outbox.

**Common mistake:**
*Weak:* "Create one stream per user."
*Correction:* 1M users = 1M streams, memory/ops overhead; use capped per-user mailbox or global stream + filtering.

---
### Q118. Compare pipelining, batching, and connection reuse — each one's win, when pipeline hurts (large replies blocking), interaction with pub/sub?

**Thought process:**
Performance techniques: reduce RTT, amortize overhead.

**Short interview answer:**
Connection reuse: keep TCP connections open (pool) to avoid handshake/overhead — win always for high QPS. Batching: group logical operations (e.g. MGET for multiple keys) to reduce calls — win when fetching known set. Pipelining: send multiple commands without waiting for replies, read all replies in order — saves RTTs, great for independent commands. Pipeline hurts when first command returns very large reply blocking subsequent processing, or when commands depend on previous results (not possible to use values). Pub/sub: PUBLISH/ SUBSCRIBE change protocol semantics; you cannot pipeline arbitrary commands freely while subscribed (SUBSCRIBE blocks in some modes, and replies are messages). Also in pipeline, all replies buffered on client.

**Deep explanation:**
RTT: 1ms, 1000 ops → pipelined 1 RTT vs 1000 RTTs. Large replies: e.g. `SMEMBERS` of 1M elements → server sends 1M elements in one reply; client must buffer/parse before reading next pipeline replies → increases memory and latency (head-of-line blocking at client). Batching via MGET/HMGET returns structured results. Pub/sub: after `SUBSCRIBE`, server sends push messages; normal request/reply protocol interleaved — pipelining across subscribe/unsubscribe tricky; better use separate connection for pub/sub or dedicated client. Also `MONITOR` streams continuously. Connection reuse: critical (each new TCP + TLS ~1-10ms). Best practice: pool connections, use pipelining for independent bulk ops, avoid huge multi-megabyte replies in tight loops, use SCAN instead.

**Common mistake:**
*Weak:* "Always pipeline everything."
*Correction:* Large replies block pipeline processing; pub/sub breaks request-reply pipelining assumptions.

---
### Q119. Lua vs application-side logic vs Redis Functions — atomicity scope, script latency risks (blocking single thread), WATCH/optimistic alternative?

**Thought process:**
Need atomic read-modify-write. Lua runs atomically on server (single-threaded) — powerful but blocks. Redis Functions (Redis 7+) similar but more flexible. WATCH/MULTI/EXEC optimistic concurrency.

**Short interview answer:**
Lua: atomic execution (no other commands interleave), runs on Redis server, good for small operations (rate limits, locks). Risk: long-running Lua blocks entire Redis (all clients wait) — must be fast (< 1ms). Application-side: read-modify-write with separate calls not atomic under concurrency. WATCH+MULTI+EXEC: optimistic locking — watch keys, read, compute, EXEC succeeds only if watched unchanged; can retry on failure (aborts). Redis Functions: server-side, can be persisted, support modules-like logic; same blocking constraint (single-threaded). Prefer Lua/Functions for atomicity; WATCH for cases where retry cheap. Never run slow scripts in prod.

**Deep explanation:**
Atomicity scope: Lua executes as one "unit" — no concurrent command runs. So `GET+INCR+EXPIRE` safe in Lua. WATCH: optimistic, allows other ops until EXEC; good for complex logic where retry rare. Latency risk: Redis is single-threaded; a Lua script doing 10^6 operations blocks all — p99 becomes terrible, can trigger failovers. Script timeout? Redis has `lua-time-limit` (deprecated in favor of max execution time), but still blocks. Redis Functions similar. Mitigations: keep scripts tiny (< 10-100 commands), avoid loops over large keyspaces, profile with `SLOWLOG`. Alternative: use data structures (e.g. HINCRBY + EXPIRE via separate commands with care? no). For rate limiting: simple Lua < 1ms fine. For large scans in Lua: bad. Also EVALSHA to reuse.

**Common mistake:**
*Weak:* "Write complex business logic in Lua."
*Correction:* Lua blocks single thread; keep minimal and fast; move heavy logic to app with optimistic locking if acceptable.

---
### Q120. Final synthesis: you own Redis at a company — write down your non-negotiables (single shared client, every key TTL'd, eviction policy chosen deliberately, never KEYS *, hit-ratio + memory dashboards, load tests for failover, app-level DB guardrails)?

**Thought process:**
Senior/staff ownership means setting guardrails that prevent common outages.

**Short interview answer:**
My non-negotiables: (1) Single shared Redis client per service with pooled connections (no per-request client creation). (2) Every key must have a TTL unless explicitly justified and documented (prevents unbounded memory). (3) Eviction policy chosen deliberately per workload (e.g. `allkeys-lru` for pure cache, `noeviction` only if stateful with capacity planning). (4) Never use `KEYS *` in prod — always `SCAN`. (5) Hit-ratio and memory dashboards on every environment with page-worthy alerts. (6) Load tests for failover (Sentinel/Cluster) and recovery before peak. (7) App-level DB guardrails (timeouts, circuit breakers, pool limits, backpressure, bounded retries with jitter) because Redis can fail. Also enforce max key size, slowlog monitoring, and idempotency for critical ops.

**Deep explanation:**
Rationale: (1) Connection churn causes latency/failures. (2) TTL prevents memory leaks; document exceptions (locks/streams with maxlen). (3) Wrong policy causes OOM or data loss. (4) KEYS blocks. (5) You can't fix what you can't measure. (6) Failover is tested, not theoretical. (7) Cache is optional; DB must survive without cache. Additional: use read-only replicas wisely, enforce Lua script size/time limits, require idempotency keys for mutating APIs, monitor replication lag, maintain runbooks, and practice chaos drills. Treat Redis as a critical dependency with explicit SLOs. Also "defense in depth": negative caching, request coalescing, hedging where safe.

**Common mistake:**
*Weak:* "Focus only on Redis config, ignore app guardrails."
*Correction:* Most Redis-related outages are mitigated by app-level protections (timeouts, backpressure, retries, circuit breakers).

---
