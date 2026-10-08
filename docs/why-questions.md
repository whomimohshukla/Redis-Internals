# The "Why" Questions (Part 46)

Interviewers rarely ask "how do you configure X". They ask **why** — because "how" only proves you read the docs, while "why" proves you understand what you are trading away. Every answer below has the same three beats: the pain that forces the decision, the 30-second version you say out loud, and the deeper trade-offs you offer before they are asked. Learn the middle part by heart; the last part is what turns a pass into a strong hire.

## Why do we need this (caching)?

### The problem first

Your product page fires 30 database queries per view. At 100 views/sec that is 3,000 queries/sec against PostgreSQL, each one a 1–15 ms index lookup plus joins.
The database runs out of connections long before it runs out of disk, and every user feels the page time.
Half of those reads are the same handful of rows — the same popular products, the same configuration, the same session — fetched over and over from durable storage that was never optimised for that job.

### The answer

> Caching keeps the hot, read-mostly slice of data in a fast store next to the application, so most requests never reach the database.
> PostgreSQL stays the source of truth; Redis holds a copy that answers in ~0.2 ms instead of 5–15 ms.

### If the interviewer digs deeper

It is a latency play first and a capacity play second: at a 95% hit ratio, 10,000 reads/sec at the app becomes 500 reads/sec at the database.
Caching does not make the database disappear — misses, writes, and analytics still hit it, so you size Postgres for the *miss* load, not for zero.
It also adds real costs: RAM for the hot set, an invalidation story, and a second system with its own failure modes.
The two numbers that prove caching works are hit ratio (`hit / (hit + miss)`) and database QPS before versus after.
It helps most where reads dominate writes; a write-heavy workload gets little from a cache and pays all of the invalidation cost.
Bad caching is worse than no caching — a stale price or a stale permission costs more than the milliseconds you saved.
The honest framing: cache what is recomputable, read-heavy, and safe to be briefly wrong.

## Why not just use PostgreSQL?

### The problem first

The obvious objection: we already run PostgreSQL, it has indexes and an OS page cache — why operate a second system?
Adding Redis means two things to monitor, two failure modes, and a consistency gap between them.
Someone has to own invalidation, and that someone is your application team, forever.

### The answer

> We do use PostgreSQL — it is the source of truth. Redis is not a replacement, it is a fast copy for the read path, plus data structures (counters, sorted sets, streams) that SQL implements slowly or awkwardly.

### If the interviewer digs deeper

A Postgres point lookup with a good index is 1–5 ms; Redis is ~0.2 ms, and the throughput gap is bigger than the latency gap — roughly 5–20k simple reads/sec per SQL node versus 100k+ ops/sec in Redis.
The shape difference matters more than the milliseconds: an atomic `INCR`, a TTL, a ZSET top-10, a stream with consumer groups are one command in Redis, and a transaction, a sweeper job, a window function, or an external broker in SQL.
The trade is genuine: an extra network hop, invalidation code, memory cost, and the fact that Redis is not durable by default so it must never hold the only copy.
PostgreSQL also wins where it should: complex joins, ad-hoc queries, transactions across entities, and anything that must survive a process restart with no configuration.
Remember that the OS page cache and `shared_buffers` already give Postgres a fast path for hot pages — Redis earns its place on repeated *application-level* reads and on data structures, not just because memory is faster than disk.
Say it as a rule: Postgres is where data is *true*, Redis is where data is *fast* — and you add Redis when measurement, not fashion, says the read path is the bottleneck.

## Why not use Redis Pub/Sub?

### The problem first

We need to tell 500 workers that a price changed. Pub/Sub is the first thing you find, and it looks exactly like a queue.
It is two commands, it is already running, and the demo works on the first try.
Nobody tells you in the tutorial that the messages only exist while someone is connected to receive them.

### The answer

> Pub/Sub is fire-and-forget: Redis stores nothing and only delivers to currently connected subscribers. Use it for ephemeral hints (live dashboards, cache invalidation, typing indicators); use Streams for anything that must arrive.

### If the interviewer digs deeper

If the subscriber is disconnected for one second, the message is gone forever — no persistence, no ack, no replay, no backpressure, and no record of who received it.
If a worker crashes after receiving a message but before finishing the work, that work is silently lost; there is no pending list to recover it from.
Buffers live in the subscriber's memory, so a slow subscriber either falls behind or gets disconnected — the producer never finds out.
Streams fix exactly this: entries are stored, consumer groups track them in a pending-entries list, and `XACK` marks completion.
Pub/Sub is still the right tool when missing a message is harmless — a missed invalidation hint heals itself at the next TTL, a missed dashboard update is corrected by the next tick, and it costs nothing when the channel is idle.
It also has one property worth naming: backpressure is absent by design, so a burst cannot make Redis hold data on behalf of a slow consumer.
The one-liner: Pub/Sub is at-most-once with zero retention; Streams is at-least-once with a receipt.

## Why not use Kafka?

### The problem first

We have events, so we need Kafka — or the reverse objection: we already run Redis, why would we ever add another cluster?
Both instincts come from treating "queue", "log" and "stream" as the same word.
The decision is really about retention, replay, throughput and who else consumes the data.

### The answer

> Different systems at different scale. Kafka is a durable, replayable distributed log with its own cluster, partitions, retention and ecosystem; Redis Streams is a queue inside the system you already operate — simpler and lower latency, but far smaller in scale and tooling.

### If the interviewer digs deeper

Kafka earns its keep when you need requirements Redis Streams does not meet: days or weeks of retention, replaying history into a brand-new consumer, hundreds of MB/s, many independent consumer teams, and strict ordering per partition.
Redis Streams keeps entries in memory — bounded by RAM and by whatever `MAXLEN` you choose — and has a much thinner ops story for rebalancing, schema evolution, and multi-team ownership.
Kafka's real cost is operational: a second cluster to provision, tune, monitor, and page someone about at 3am.
Conflating them is the actual interview mistake: one Redis stream is not a Kafka replacement, and "we use Streams" is not an answer to a retention or replay question.
Conversely, "just use Kafka" for a single internal job queue is buying a freight train to move a suitcase.
Kafka also pushes you toward an ecosystem (Connect, Schema Registry, a stream-processing layer) that you adopt whether you needed it or not.
Choose by asking two questions: how long must this be replayable, and how many independent systems consume it?

## Why TTL?

### The problem first

Cache entries go stale and abandoned keys never disappear. Nobody is awake at 3am to decide when a value is old enough to throw away.
Without expiry, memory usage is a monotonic curve that ends in an out-of-memory kill during your busiest hour.
Staleness is invisible too: you have no idea how old the value you just served actually is.

### The answer

> TTL bounds staleness and reclaims memory automatically: the worst case is that a value is TTL-old, and unused keys clean themselves up. It is a safety net, not a consistency guarantee.

### If the interviewer digs deeper

A TTL cannot know your data changed — write one second after a 300-second expiry and you serve wrong data for up to 300 seconds, so TTL alone is not consistency; combine it with delete-on-write.
What TTL *does* give you: an upper bound on how long garbage survives, automatic memory reclamation (a missing TTL is the classic "Redis memory keeps climbing" incident), and the actual mechanism behind presence heartbeats and rate-limit windows.
Add jitter so a batch of keys written together does not expire together — otherwise they all miss at once and stampede the database.
Pick TTLs per workload: ~60 s for prices, days for feeds, seconds for presence, none for a URL map or a leaderboard.
Remember that expiry is lazy and sampled: a key with no reader may linger briefly after its deadline, so TTL is a bound, not a scheduler.
The failure mode to mention: `SET` followed by a separate `EXPIRE` that never runs after a crash silently becomes no TTL at all — make it atomic with `SET key value EX 60` or one Lua script.

## Why cache-aside?

### The problem first

Somebody has to load the cache. The app, the database, or a library? And what happens the moment the cache is empty — at startup, after a flush, or during a deploy?
If the wrong component owns the fill, a cold cache can turn into a thundering herd against your database.
You also need to know what happens to your write path when Redis is unavailable.

### The answer

> Cache-aside: the application reads the cache, and on a miss reads the database and writes the result back. The database stays the source of truth, the cache may be empty at any time, and no write path is coupled to Redis.

### If the interviewer digs deeper

The alternatives each cost something: write-through adds a synchronous Redis write to every update (latency plus wasted work for keys nobody reads), write-behind can lose acknowledged writes, and read-through hides the load inside a library you cannot easily observe.
Its known downsides are stampede (thousands of readers miss the same key at once — fix with a `SET NX` recompute lock or probabilistic early refresh) and fill races (two readers filling the same key is harmless, but a reader can refill stale data right after a delete — so always delete on write, and version the value if you need to be sure).
A cold cache is a burst of database reads, which you handle by warming keys on deploy instead of letting production discover them.
It also degrades gracefully: if Redis is down, you are back to database reads — slower, but correct.
That last property is why cache-aside is the default — it fails toward "no cache" rather than toward "wrong data".
The cost sits in the application: every read path must handle hit, miss, and refill, so the pattern only pays off if that logic lives in one shared helper rather than copied into forty handlers.

## Why replication?

### The problem first

One Redis box serves reads right up until it does not — and if it dies, everything stops.
Duplicating the process on a second machine seems like the obvious fix, but people then assume the copy is free and perfectly in sync.
Neither assumption survives contact with a failover.

### The answer

> Replicas copy the primary asynchronously so you get two things: read throughput spread across replicas, and a standby that can be promoted when the primary fails.

### If the interviewer digs deeper

Replication multiplies *read* capacity; it does not multiply write capacity or total memory — that is sharding's job, and it is the most common confusion in this area.
Because Redis replication is asynchronous, a replica can lag tens or hundreds of milliseconds, so a read-your-own-write (profile saved, then shown) must go to the primary or you will show old data.
Failover can lose the last acknowledged writes: the promoted replica may simply not have received them. Replication is availability, not durability.
Replication also does not decide who is primary — Sentinel or Cluster does the detection and promotion, and clients must be reconfigured to find the new one.
There is a scaling limit hiding here: replicas still receive every write, so a very write-heavy primary can saturate before the replicas ever help.
A strong closing line: replication is for reads and failover, cluster is for capacity, and neither one turns Redis into a consensus system.

## Why cluster?

### The problem first

The dataset no longer fits in one machine's RAM, or one single-threaded core is pinned at ~150k ops/sec.
Adding replicas does not help — they hold exactly the same data and the same ceiling.
Sharding by hand in application code means every reader must know where every key lives, which nobody maintains for long.

### The answer

> Redis Cluster shards keys across masters by hash slot, so total memory and write throughput grow with the number of nodes, while every key still lives on exactly one shard.

### If the interviewer digs deeper

There are 16384 slots; a key belongs to slot `CRC16(key) % 16384` (or the CRC of its `{tag}` if present), which is why clients can route to the right node without asking.
The consequences are what interviewers probe: multi-key commands only work when every key hashes to the same slot — that is precisely what hash tags exist for — and each shard is still single-threaded, so scaling is horizontal only.
Resharding moves slots between nodes and costs latency and network while it runs; plan it, do not trigger it by accident.
Cluster does not fix a hot key: one viral key still lands on one shard, so you need a local cache or to split the key.
It also adds operational surface — node failures, slot migration, partial partitions where some keys are unavailable while others answer fine.
And the timing question: you rarely need it early. One primary plus replicas covers surprising load — reach for Cluster when you are provably out of RAM or out of write throughput.

## Why Sentinel?

### The problem first

The primary Redis process crashes at 2am. Who notices? Who promotes a replica? How do the app servers find the new primary?
Without an answer, promotion is a human with a terminal and an outage clock.
Even with a manual promotion, stale client configurations keep sending writes into a void.

### The answer

> Sentinel is Redis's separate failure-detection and failover system: a small quorum of Sentinel processes watches the primary, declares it down by majority vote, promotes a replica, and tells clients where the primary moved.

### If the interviewer digs deeper

The quorum is the point — one monitor's network blip must not cause a failover, and majority voting is what keeps the minority side from accepting writes (split-brain protection).
Sentinel stores no data; it is a coordinator, not a store, so you run three or five of them, not one.
Failover still loses the last few writes, because replication is asynchronous and the promoted replica may be behind — say this out loud, it separates candidates who have run failovers from those who have not.
Clients must be Sentinel-aware and resolve the current master dynamically, otherwise you get a wave of 502s until someone restarts the app.
Sentinel's health checks also decide when a replica is promoted and when the old primary is reintroduced — get that wrong and you get two writers briefly.
Compare deliberately: Sentinel is one primary with automatic failover and no sharding; Cluster is sharding with built-in failover; managed Redis is somebody else running Sentinel for you.
And the sharp line: a lock held across a failover is not a guarantee — this is detection and promotion, not consensus.

## Why consumer groups?

### The problem first

One worker reading a stream is a bottleneck. Five workers each reading the whole stream duplicate every job five times.
Polling with `XREAD` in a loop gives you neither parallelism nor a record of what was handed out.
You need competing consumers without losing track of who owes what.

### The answer

> A consumer group makes competing consumers safe: inside the group each message goes to exactly one consumer, Redis tracks what was delivered but not yet acknowledged, and each separate group gets the full stream independently.

### If the interviewer digs deeper

`XREADGROUP GROUP g consumer` reads new messages and records them in that consumer's pending-entries list (PEL), so the stream knows exactly which messages are outstanding — that bookkeeping is what makes crash recovery possible at all.
Adding workers inside the group increases throughput nearly linearly until Redis or the downstream dependency saturates.
Two groups on one stream give broadcast semantics: a monitor and a business processor each see every message without interfering with each other.
The group also owns its own read position, so two deployments can process the same events with different speeds and neither can steal from the other.
Gotchas worth mentioning: group progress is per-group, so a forgotten group name silently starts from the wrong position, and one slow consumer can starve until you claim its idle messages with `XAUTOCLAIM`.
The one-liner: a group gives you parallelism *plus* accountability — that is why five workers on `BRPOP` is not the same thing.

## Why ACK?

### The problem first

A worker picks up a job, then its container is killed mid-way. Did the job run? Should Redis hand it to someone else?
Without an explicit acknowledgement there is no way to distinguish "still being processed" from "processed and lost in the reply".
Both answers are wrong in different, expensive ways.

### The answer

> `XACK` tells Redis the message is handled and drops it from the pending list — it is the boundary between "delivered" and "done". Not acking means redelivery; acking means you own the outcome.

### If the interviewer digs deeper

Ack before doing the work and you can lose it on a crash (at-most-once); ack after doing the work and you can run it twice (at-least-once). Every real system chooses the second, because duplicated work is recoverable and lost work is not.
The pending list doubles as your monitoring surface: `XPENDING` shows how many messages are stuck and for how long, which is exactly the number you alert on.
`XAUTOCLAIM` reassigns messages whose consumer died, after an idle timeout you choose — that is the retry path, and it only exists because the ack was not sent.
Acking is also cheap: one O(1) command per message, so batching acks (ack after a small batch of work) is a legitimate optimisation as long as your crash window is acceptable.
Contrast with lists: `BRPOP` deletes an item the instant you receive it, so there is nothing to ack and nothing to recover. That single difference is why streams exist for job processing.
Say it in one line: an ACK converts "maybe processed" into "at-least-once, with a receipt".

## Why idempotency?

### The problem first

Retries are everywhere: a client retries a timeout, Redis redelivers after a worker crash, a message is processed twice, a user double-clicks Pay.
If the second run charges again, the bug is not in Redis — it is in your assumption that each request happens once.
You cannot make delivery exactly-once over a network, so the handler has to be the thing that makes duplicates harmless.

### The answer

> Idempotency makes the second run harmless — the same operation executed twice has the same effect as once. You get there with an idempotency key (`SET ... NX`), a unique database constraint, or a deterministic result key.

### If the interviewer digs deeper

Exactly-once delivery does not exist across a network; what exists is at-least-once delivery plus handlers that ignore duplicates.
For a payment, `SET idem:<key> pending NX EX 300` elects exactly one winner; the losers either replay the stored response or are told to retry later.
For a stream, writing to `survey:<id>:result` overwrites the same row instead of appending a second one — redelivery becomes a no-op.
For a database insert, a unique index on the business key turns a duplicate insert into a no-error conflict you can detect and ignore.
The window matters: idempotency keys need a TTL, so a retry five days later is *not* deduplicated. Decide that window deliberately rather than inheriting it from a default.
A database unique index is your last line of defense when Redis itself is unavailable — put it under the Redis logic, not instead of it.
The quotable version: "we do not prevent duplicates, we make them cheap — at-least-once plus idempotency".

## Why hash tags?

### The problem first

In Cluster mode `MGET a b c` fails with `CROSSSLOT`, and a Lua script touching two keys dies — even though the keys obviously belong to the same entity.
Nothing about your data model changed; only the way keys are placed changed.
Multi-key atomicity suddenly becomes a routing problem.

### The answer

> Hash tags force related keys into the same slot: only the text inside the first `{...}` is hashed, so `{user:7}:cart` and `{user:7}:prefs` always land on the same shard.

### If the interviewer digs deeper

Without a tag, placement is the CRC of the whole key, so `user:7:cart` and `user:7:prefs` are almost certainly on different masters — and any multi-key atomic operation is rejected rather than degraded.
Tag wherever you need multi-key atomicity: `MGET`, transactions, Lua scripts, or deleting an entity's sub-keys in one round trip.
The trade-off is concentration: everything tagged together lives on one shard, so a hot entity creates a hot slot. Tag by the smallest unit that must stay together (a user, an order) — never by tenant, region, or "everything".
Also know the edge cases: braces inside a key change hashing even when you did not intend a tag, and unbalanced braces mean the whole key is hashed.
Tagging is one of the few design decisions you cannot retrofit cheaply after data is distributed, so settle it before the first production key is written.
The rule to state: use tags deliberately, and identically in development and production, or bugs only appear after you enable Cluster.

## Why pipelining?

### The problem first

Your handler does 10 Redis reads per request. Locally each is 0.2 ms — but over a 5 ms link to another availability zone, that is 50 ms of pure waiting per request.
At 200 req/s your service is spending most of its life waiting for sockets, not computing anything.
The commands themselves are trivial; the round trips are the expense.

### The answer

> Pipelining sends many commands in one write and reads all the replies in one read, cutting latency from N round trips to roughly one. It does not make Redis faster; it stops you paying for the trip N times.

### If the interviewer digs deeper

In `redis` v4+ commands issued in the same tick are auto-pipelined, but the classic mistake is awaiting each call in sequence — every `await` forces a full round trip before the next command is even sent.
Combine client pipelining with server-side batching commands (`MGET`/`HMGET`/`MSET`) so you also move fewer bytes.
Bound the size: a pipeline of 100,000 commands is one giant blocking request on Redis's single thread and delays every other client — chunk at a few thousand commands.
It does not reduce the server's execution work, so if Redis itself is the bottleneck, pipelining will not save you; measure `INFO commandstats` before and after.
It also changes failure handling: with N separate calls you can react to failure number 3; in one pipeline you typically get all N replies or a connection error and must reason about what actually executed.
Numbers make it convincing: 10 commands go from ~2 ms to ~0.4 ms locally, and from ~50 ms to ~6 ms over the slow link.

## Why local cache?

### The problem first

A trending product is read 20,000 times/sec across your API nodes — 20k network round trips per second for one key.
That Redis shard's CPU becomes the ceiling for your whole service, and every API node is paying latency for a value almost never changes.
Adding replicas copies the data but not the hot key problem; the key still gets hammered.

### The answer

> A tiny in-process LRU keeps the hottest few hundred keys in the application's own memory, so those reads cost microseconds and never leave the box — and one hot key can no longer pin a Redis shard.

### If the interviewer digs deeper

The costs are bounded and you should name them: memory is duplicated across N nodes, each node may briefly hold a different value (seconds of divergence), and you need a short TTL (1–30 s) or a Pub/Sub invalidation broadcast to keep them honest.
It works because of *what* you put there: the hottest data, which is also the data that is safe to be a second stale.
Never keep balances, permissions, or inventory locally — revocation and read-your-own-writes both break immediately.
It also improves failure behavior: if Redis is unreachable, the hot entries still serve, which is a graceful degradation you can point to in an outage review.
The invalidation channel is optional, not free: broadcast costs a Pub/Sub subscriber per node, and a missed message is only bounded by your local TTL.
A typical configuration is one thousand entries, a 15-second TTL, LRU eviction, and one invalidation channel.
The line to remember: the local cache absorbs the hot key, Redis serves the long tail, and PostgreSQL remains the truth.

## Why not cache everything?

### The problem first

If caching makes things fast, why not write every row we ever read into Redis and stop deciding?
It feels simpler than drawing a line, and nobody wants to be the person who picked the wrong thing to cache.
"Everything" also sounds like it should be the safe, uniform option.

### The answer

> Because access is skewed and memory is not free: a small fraction of the data gets most of the reads, and every extra cached copy is another thing that can go stale. Cache the hot, read-heavy, recomputable slice — leave the cold tail in PostgreSQL.

### If the interviewer digs deeper

Typical workloads are 80/20 or 90/10: caching a 10M-row catalog costs 10+ GB of RAM to hold rows nobody will ever request again, while the top 1% of keys drives most of the traffic.
Every cached key adds invalidation surface — the more you store, the more places a write must remember to clean up, and the more ways you can serve something stale.
TTL does not rescue this decision: a TTL on data that should never have been cached is just wrong data that heals slowly.
Some of it is actively dangerous to cache — balances, permissions, rate-limit state — because a stale copy is a correctness or security bug, not a slow page.
There is also a hard floor: Redis memory is RAM-priced and bounded by one process's address space, so "everything" has a ceiling you will hit at the worst possible time.
Caching everything also hides your access pattern: once every read is served from Redis, you stop seeing which data is actually hot, and your capacity plan becomes guesswork.
The disciplined version: cache what you can rebuild, measure the hit ratio, and let the miss path prove the database still works.
