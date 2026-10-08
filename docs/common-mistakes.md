# Common Redis Interview Mistakes

These fifteen answers come up in almost every Redis or system-design round, and each one costs you points — not because the candidate is wrong about syntax, but because the claim collapses the moment the interviewer asks a follow-up. Each entry gives you the instinct that makes it sound right, why it fails, what it costs in production, and the sentence that replaces it. Print the "Say this instead" lines; they are the ones worth memorising.

## 1. "Redis is always a database."

**Why it sounds right:** You persist data, you run `SET` and `GET`, you configure RDB snapshots.
From the client's seat it behaves like a very fast key-value store, and plenty of people do keep their sessions and rate-limit counters in it.

**Why it's wrong:** Redis is a data structure server that keeps everything in RAM and, by default, does not promise durability.
It has no joins, no cross-entity transactions, and no query planner.
It is often the *fast copy* of data whose truth lives in PostgreSQL — or a cache, queue, lock, or counter, which are roles a database is not usually asked to play.

**What it costs you:** If you design a system where orders and payments exist only in Redis with default configuration, a failover, an OOM kill, or a restart turns into data loss that users notice immediately.
You also end up reimplementing in application code everything SQL gives away for free.

**Say this instead:** "Redis is a fast, in-memory copy — it holds authoritative data only for ephemeral state like sessions, queues and counters; durable business records live in PostgreSQL."

## 2. Saying Redis guarantees exactly-once processing.

**Why it sounds right:** Streams have consumer groups, pending lists and `XACK`, and that machinery feels airtight — the message is delivered, tracked, and confirmed.

**Why it's wrong:** Every part of it is at-least-once.
A worker can finish the work and crash before `XACK`, so Redis redelivers; a failover can replay the tail of the log; a client timeout can re-send a request.
No distributed system makes duplicate work impossible across a network — you can only make duplicates harmless.

**What it costs you:** A worker crash at the wrong millisecond means two invoices charged, two emails sent, or two rows inserted, and you find out from a customer.

**Say this instead:** "Redis gives at-least-once delivery with acknowledgements — exactly-once *behaviour* is something you build with idempotent handlers and unique keys."

## 3. Saying Redis Pub/Sub is durable.

**Why it sounds right:** It is called publish/subscribe, one message reaches hundreds of subscribers, and it ships with Redis, so it must be a reliable messaging channel.

**Why it's wrong:** Pub/Sub stores nothing.
Messages exist only while they are being delivered to currently connected subscribers — no persistence, no acknowledgement, no replay, no backpressure, and no record of who got what.
If the subscriber is offline for one second, the message is gone.

**What it costs you:** An order-shipped event published while a worker is reconnecting is simply lost, and there is nothing to recover it from — the user never gets notified and no log proves it was sent.

**Say this instead:** "Pub/Sub is ephemeral — at-most-once with zero retention.
It is perfect for invalidation hints and live dashboards; anything that must arrive belongs in a Stream or a real broker."

## 4. Saying Redis Streams and Kafka are identical.

**Why it sounds right:** Both are append-only logs, both have consumer groups, offsets, and parallel consumers, so the concepts map one-to-one and Redis is easier to run.

**Why it's wrong:** The concepts rhyme; the systems do not.
Redis Streams keeps entries in memory, bounded by RAM and `MAXLEN`, with a thin ops story.
Kafka is a distributed log on disk with partition-based ordering, multi-day retention, replay into new consumers, hundreds of MB/s throughput, and an ecosystem (Connect, Schema Registry, stream processing) around it.

**What it costs you:** Choosing Streams for week-long replay and a dozen independent consumer teams hits a memory ceiling and a missing tooling story; choosing Kafka for one internal job queue buys a second cluster that pages someone at 3am.

**Say this instead:** "Streams and Kafka solve the same *shape* of problem at different scale — Streams is an in-memory queue inside the system I already run; Kafka is a durable log with replay and its own ecosystem."

## 5. Saying Redis Cluster and Sentinel are the same.

**Why it sounds right:** Both watch for failures, both promote replicas automatically, and both are usually described in one breath as "Redis high availability".

**Why it's wrong:** Sentinel is a separate monitoring process that provides failover for a single primary — it adds no capacity and no sharding.
Cluster is a data-sharding mode where keys are split across masters by hash slot, with failover built in.
One solves "who is the primary?", the other solves "where does this key live?".

**What it costs you:** You deploy Sentinel when your real problem is a dataset that no longer fits in RAM or a single core pinned at 150k ops/sec — you get automatic failover and exactly the same ceiling.

**Say this instead:** "Sentinel buys high availability for one primary; Cluster buys capacity by sharding.
Different problems — I pick based on whether I'm limited by failure or by scale."

## 6. Saying adding nodes solves every hot-key problem.

**Why it sounds right:** Cluster scales horizontally, more nodes means more throughput, so any hot workload should spread out as you add machines.

**Why it's wrong:** Sharding distributes *keys* across slots, and a key lives on exactly one slot forever.
All reads and writes for that one viral product, trending topic, or global counter still land on one shard — while the other nodes sit idle.
Replicas help only if you can serve that key's reads from them, and they never absorb its writes.

**What it costs you:** Your biggest traffic moment pins one shard at 100% CPU, commands queue up, timeouts cascade, and scaling out does nothing because the bottleneck is one key.

**Say this instead:** "Sharding spreads different keys, not one key — a hot key needs a local in-process cache, key splitting, or rate limiting, not more nodes."

## 7. Saying TTL solves all cache consistency issues.

**Why it sounds right:** Every key expires, so stale data is thrown away automatically and can never linger forever.
Set a TTL and consistency takes care of itself.

**Why it's wrong:** A TTL bounds *age*, not correctness — Redis has no idea when your row changed.
A price written one second after a 300-second expiry is still served wrong for almost the full TTL, and a TTL gives you no read-your-writes guarantee at all.
It also does nothing for a delete that races with a concurrent refill.

**What it costs you:** A flash-sale price changes and users keep buying at the old price for up to five minutes, or a banned user's permissions survive until their session key happens to expire.

**Say this instead:** "TTL bounds how long data *can* be stale; correctness comes from invalidating on write.
TTL is the safety net, not the consistency mechanism."

## 8. Saying 99% hit rate means the database is safe.

**Why it sounds right:** If 99 out of 100 reads never touch PostgreSQL, the database is clearly out of the hot path and can relax.

**Why it's wrong:** Hit ratio describes average *read* efficiency only.
One percent of a million requests per second is still 10,000 misses/sec hitting the database, and misses are not independent — a mass TTL expiry, a deploy that flushes the cache, or a cold start makes them all land in the same second.
Writes, analytics, and ad-hoc queries never appear in the hit ratio at all.

**What it costs you:** The database is sized for a smooth trickle, then a cache flush at deploy time delivers a synchronized stampede and the connection pool exhausts exactly when traffic is highest.

**Say this instead:** "Hit ratio measures read efficiency; the database is sized by miss rate, write volume, and worst-case bursts — not by the average."

## 9. Using `KEYS *` on huge production datasets.

**Why it sounds right:** It is the obvious command, it works instantly in development, and you just need a quick list of matching keys.

**Why it's wrong:** `KEYS` is O(N) and runs in Redis's single thread — it blocks the server while it scans the entire keyspace.
On ten million keys that is seconds of frozen service for every client connected, and the blockage also delays replication and can trigger failovers.

**What it costs you:** A "quick check" in production becomes a multi-second outage: every command times out, the replication link backs up, and your monitoring lights up — for a script nobody needed to run live.

**Say this instead:** "`SCAN` with `MATCH` and a `COUNT`, iterated client-side — `KEYS` is an administrative command for an idle instance, never a query."

## 10. Creating a new Redis connection for every request.

**Why it sounds right:** One connection per request is clean, stateless, and matches the instinct you brought from HTTP handlers, where connection-per-request is normal.

**Why it's wrong:** Every request pays a TCP handshake, an auth round trip, and socket setup, and Redis (single-threaded) spends real CPU accepting and tearing down sockets instead of running commands.
Under load this becomes a connection storm: thousands of sockets, ephemeral port pressure, and latency that grows exactly when you need it not to.

**What it costs you:** Latency creeps from 0.2 ms to tens of milliseconds, you hit "max clients" errors during a traffic spike, and Redis's CPU graph is dominated by accept() rather than GET.

**Say this instead:** "Create one shared client at startup and reuse it for the process lifetime — the Node client multiplexes commands over a single connection."

## 11. Treating a distributed lock as perfect.

**Why it sounds right:** `SET lock:job 1 NX EX 30`, release with a token check — mutual exclusion across all your servers, done.

**Why it's wrong:** A Redis lock is a *lease with a deadline*, not consensus.
The holder can pause (GC, long GC, laptop sleep, network partition) past its TTL while the lock expires and a second holder takes over; a failover can promote a replica that never saw the lock; Redis has no fencing mechanism to stop the old holder from acting.
Two processes can genuinely believe they own it.

**What it costs you:** Two workers process the same invoice because the first one overran its lease — and the lock happily reports no conflict, because both acquisitions were "valid" when they happened.

**Say this instead:** "A distributed lock is a best-effort lease, not consensus — use it to reduce contention, and make the protected work idempotent or fenced so a stale holder can't corrupt anything."

## 12. Ignoring duplicate processing (not being idempotent).

**Why it sounds right:** Our retries are bounded, our queue tracks messages, and we have a lock — so each job really does run once in practice.

**Why it's wrong:** Once a request crosses a network you cannot tell "failed" from "succeeded but the reply was lost", so retries are not an edge case, they are the design.
At-least-once delivery, client timeouts, and failover replays guarantee duplicates; a lock with a TTL does not change that.

**What it costs you:** Double charges, two identical confirmation emails, counters that tick twice, and rows inserted twice — all appearing only in production, under load, days after launch.

**Say this instead:** "Assume every operation can run twice — deduplicate with an idempotency key, a deterministic result key, or a database unique constraint."

## 13. Ignoring replication lag (read-after-write).

**Why it sounds right:** Writes go to the primary and replicas copy them immediately, so any read can safely go to any node.

**Why it's wrong:** Redis replication is asynchronous, so a replica can be tens or hundreds of milliseconds behind — sometimes more under load or after a failover.
A user who updates their profile and then reloads the page reads from a replica that has not seen the write yet; session revocation, feature flags, and rate-limit checks have the same problem.

**What it costs you:** "I saved my settings but they reverted" support tickets, or a just-logged-out session authenticating one more time — small windows individually, but they read as data loss to users.

**Say this instead:** "Replicas lag — read-after-write traffic goes to the primary, and everywhere else I accept and can state the staleness window."

## 14. Ignoring memory overhead (values + keys + fragmentation + replicas).

**Why it sounds right:** Your JSON payloads total 1 GB, you bought a 1 GB Redis, therefore it fits.
Memory looks like a simple sum of values.

**Why it's wrong:** Every key carries its own structure overhead (dict entry plus encoded string, commonly 40–100+ bytes), small hashes and sets pay per-element costs, the allocator fragments by 10–30%, and you also need room for replicas, RDB/AOF buffers, and fork copy-on-write spikes.
Real usage runs well above the size of the payloads you measured.

**What it costs you:** The instance hits its limit at what you thought was 70% usage, starts evicting keys you needed (or refuses writes entirely if persistence is on), and you debug "phantom" memory for a day.

**Say this instead:** "Budget roughly 1.3–2x the raw size of my values — keys, per-element overhead, fragmentation, and replicas all count against the limit."

## 15. Caching everything.

**Why it sounds right:** Caching is fast, caching has made every system I've shipped snappier, so caching every row I read must be the safest, most uniform choice.

**Why it's wrong:** Access is skewed — a small fraction of data gets most of the reads, so the cold tail costs RAM and delivers nothing.
Worse, every cached key is one more thing that can go stale and one more place a write must remember to clean up, and some data (balances, permissions, inventory) is unsafe to cache at all because a stale copy is a correctness or security bug.

**What it costs you:** A memory bill for rows nobody reads, invalidation bugs that surface as wrong prices, and a system where every read is served from cache — so you stop seeing which data is actually hot and plan capacity by guesswork.

**Say this instead:** "Cache the hot, read-heavy, safely-stale-able slice — PostgreSQL still owns the cold tail, and I can prove it works with the hit ratio."
