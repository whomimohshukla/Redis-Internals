# Redis in Real System Designs (Tiny Examples)

These are **not** full applications. Each section is a small architecture sketch that shows *where* Redis sits, *what* goes into it, and *what breaks* when it goes away. Every sketch is deliberately tiny so you can redraw it on a whiteboard in under two minutes. Read them as interview rehearsal: the diagram is the answer skeleton, the subsections are the follow-up questions.

## 1. URL shortener

### Architecture
```
  +--------+      +-----------------+      +--------+
  | Client | ---> |   API service   | ---> | Redis  |
  +--------+      | POST /shorten   |      +--------+
                  | GET  /:code     |        ^    |
                  +-----------------+        |    | miss
                                        write|    v read
                                       +-----------+
                                       | PostgreSQL|  <- source of truth
                                       +-----------+

  GET /Ab3xY9  ->  Redis GET short:code:Ab3xY9   (~0.2 ms, hit 99% of reads)
  miss         ->  SELECT ... WHERE code='Ab3xY9' (~5 ms) -> refill cache
```

### Why Redis?
Reads are a single O(1) `GET` on a key that is basically the whole payload. A local Redis answers in ~0.2 ms; a Postgres point lookup is ~3–15 ms. One instance handles 100k+ operations/sec, and redirects are the single hottest path in this product. The alternative — `SELECT` on an indexed column for every redirect — works until the traffic spike, then you are paying 50x latency for data that never changes after it is written.

### What data goes in Redis?
Two string keys, nothing fancy:

```text
short:code:Ab3xY9        -> "https://example.com/very/long/url?with=query"
short:url:<sha256(url)>  -> "Ab3xY9"        (dedupe: same URL -> same code)
```

The reverse key matters: without it every `POST /shorten` mints a new code for the same landing page and your memory grows with request count instead of with unique URLs.

### TTL?
Usually **none**, or an absurdly long one (`EX` in years). A short link that dies after 30 days is a bug, not a feature — links get pasted into newsletters and Slack messages that are read years later. Memory is bounded by *unique URLs*, not by time, so a TTL does not save you much. If you do offer expiring links (campaigns), encode the expiry in the product requirement and set `EX 2592000` (30 days) only for that key namespace.

### Key design?
- Short keys: the Redis key **is** the redirect, so `short:code:Ab3xY9` keeps overhead tiny. At ~40 bytes/key of Redis overhead, key length directly costs RAM at 100M links.
- Base62 codes, 7 characters = 62^7 ≈ **3.5 trillion** codes, so no collisions and no need to check first.
- Never use auto-increment IDs (`?id=1234`) — they are enumerable, and someone will crawl your entire database in an afternoon.
- Keep the reverse-lookup key hashed (`sha256`) so the key length is fixed regardless of URL length.

### Consistency?
Postgres is the source of truth; Redis is a fast copy. **Write order: DB first, then cache.** If the cache write fails you merely lose a few milliseconds on the next read; if you wrote the cache first and the DB insert failed, you would serve a link that resolves to nothing. Redirects are append-only, so staleness is essentially zero — the only divergence you can get is a deleted/expired link still redirecting until its cache entry is invalidated.

### Failure modes?
| Failure | Behaviour | Fix |
|---|---|---|
| Redis restarts empty | every redirect falls back to Postgres for a while | RDB snapshot + AOF, and the DB fallback keeps the product alive |
| Redis unreachable | 100% DB load — a 20x traffic jump | read replicas, circuit breaker, and a local in-process LRU for top-10k codes |
| One viral link | one hot key, one shard overloaded | serve it from a small local cache on each API node |
| Cache write races with delete | stale link survives | links are immutable; only delete on explicit URL removal |

### Scaling?
Start with one instance + cache-aside. Reads scale horizontally with **read replicas** (`READONLY` clients pointed at replicas), because redirects are read-only. When you exceed one machine's RAM (roughly 100M+ links with overhead), shard by code prefix — `short:code:*` on shard 1, etc. Writes are rare, so shard rebalancing is cheap. The DB keeps the full dataset, so a shard can be rebuilt by scanning the table.

### Interview follow-ups
**Q: What if two requests generate the same code?** A: Collision check is `SET short:code:<code> <url> NX` — the loser regenerates. Or generate from a counter plus a random salt and treat the `NX` as the only authority.

**Q: How do you prevent someone from enumerating all links?** A: Random base62 codes with enough entropy (7+ chars ≈ 40 bits), no sequential IDs, plus rate limiting on `POST /shorten`.

**Q: Where do you store click analytics?** A: Not in the redirect path. `INCR short:code:<code>:clicks` is cheap and atomic if you need a live counter, but real analytics go to a stream/batch pipeline — the redirect must never wait on analytics.

**Q: What happens when a URL is taken down for abuse?** A: `DEL short:code:<code>` plus a delete in Postgres. The window where it still resolves is bounded by the cache write you just did — invalidation, not TTL, is the guarantee.

## 2. Instagram-style feed

### Architecture
```
  +--------+     +----------+     +---------------------------+
  | Client | --> |   API    | --> | Redis                     |
  +--------+     +----------+     |  feed:42   (ZSET of postIds)|
                                  |  post:991  (HASH metadata) |
                                  |  user:42:following (SET)   |
                                  +-------------+-------------+
                                                | miss / cold
                                                v
                                       +-----------------+
                                       |   PostgreSQL    |
                                       +-----------------+
```

### Why Redis?
A feed is a **fan-out**: one user's request would otherwise be `SELECT * FROM posts WHERE author IN (following list of 200 people) ORDER BY created_at DESC LIMIT 20`. That is a fat query with a large `IN` list and a sort on every request. With Redis the timeline is *precomputed* as a sorted set: `ZREVRANGE feed:42 0 19` returns 20 post IDs in ~0.3 ms, then 20 pipeline'd `HMGET`s fetch the bodies. You trade write-time work for read-time simplicity, and feeds are read roughly 100x more than they are written.

### What data goes in Redis?
```text
feed:<userId>            ZSET   member=postId  score=createdAt (epoch ms)
post:<postId>            HASH   {author, caption, mediaUrl, likeCount}
user:<userId>:following  SET    member=followedUserId
post:<postId>:likers     SET    member=userId
```

The feed stores **IDs only**, not the post bodies. Bodies change (likes, edits) and would force you to rewrite every follower's feed; IDs let you hydrate at read time from a cache that is shared by everyone.

### TTL?
Yes — typically **1 to 7 days** (`EXPIRE feed:42 604800`). A feed is a *reconstructible* projection: on a miss, rebuild it from `user:42:following` + recent posts. TTL also bounds how long a deleted/blocked user's post can linger in someone's feed. The `post:*` and `user:*` caches can have a shorter TTL (5–60 min) since they are shared and cheap to rebuild.

### Key design?
One feed key per user, no wildcards, no scans. Score = timestamp so recency ordering is free. Keep `feed:<userId>` under a few hundred entries and `ZREMRANGEBYRANK feed:<userId> 0 -501` on insert so the set never grows past 500 posts — nobody scrolls past that. Following lists are kept as a `SET` so `SMEMBERS`/`SINTERSTORE` can rebuild a feed without touching the DB.

### Consistency?
**Eventual, on purpose.** Fan-out-on-write means when A posts, your write path loops over A's followers and `ZADD`s into each `feed:<id>`. If that loop crashes halfway, some followers see the post and some do not — until the feed is rebuilt or TTL expires. Reads are always *at least* the DB state (rebuild path) and *at most* slightly stale. The database stays the source of truth for what was actually posted.

### Failure modes?
- **Celebrity fan-out:** one account with 100M followers makes a single post cost 100M `ZADD`s. That is the classic reason to use *fan-out on read* for large accounts: keep their posts in `post:<celebId>` and merge them into the timeline at read time.
- **Memory:** 500 posts × 40 bytes overhead × 100M users does not fit. Feeds must be sharded or only materialized for active users (rebuild on first read after a week of inactivity).
- **Stampede:** a trending post hit by millions → rebuild the same feed simultaneously. Guard with a short-lived `NX` lock per rebuild (see `npm run pattern:stampede`).

### Scaling?
Shard by `userId` (hash of the ID) so each user's feed lives on exactly one shard — a feed is never split. Hydration (`post:*`) is the part that scales badly, so it is pipelined and served from replicas. Reads go to replicas; writes (`ZADD` on fan-out) go to the primary. When memory runs out, the first thing to shrink is feed length, not post bodies.

### Interview follow-ups
**Q: Fan-out on write or on read?** A: Fan-out on write for normal users (cheap, fast reads), fan-out on read for celebrities (avoid 100M writes). Hybrid is the industry answer.

**Q: How do you show a "new posts" badge instead of re-rendering?** A: `ZCOUNT feed:42 <lastSeenScore> +inf` — one O(log N) call, no payload.

**Q: What if the Redis fan-out write fails mid-way?** A: Rebuilding from the DB on read heals it; that is exactly why the feed is a projection and not the source of truth.

**Q: Where do likes live?** A: `post:<id>:likers` as a `SET` (gives you O(1) "did I like this?") with the count mirrored in the HASH; the DB records the durable like.

## 3. WhatsApp presence/online status

### Architecture
```
  +--------+   heartbeat / activity    +------------------+
  | Client | ------------------------> |  Chat service    |
  +--------+   (every 30-60s)          +---+----------+---+
                                          |          |
                SET presence:u7 <ts> EX 60 |          | PUBLISH presence:u7 online
                                          v          v
                                     +--------+  +--------------+
                                     | Redis  |  | subscribers  |
                                     +--------+  | (other users)|
                                                 +--------------+
```

### Why Redis?
Presence is **millions of tiny writes** ("I am still here") and **millions of tiny reads** ("is she online?"). That is exactly Redis's shape: `SET`/`GET` at ~0.2 ms, and — the important part — **the TTL *is* the feature**. Redis expires the heartbeat for you, so "online" means "a key that exists right now". No cron job, no background sweeper table, no `UPDATE users SET last_seen = now()` on every read.

### What data goes in Redis?
```text
presence:<userId>     ->  "2026-10-08T10:15:00Z"   with EX 60   (heartbeat)
lastseen:<userId>     ->  epoch seconds            no TTL        (durable-ish)
```

The heartbeat key's *existence* is the online flag; its *value* is the last activity timestamp for the offline case. When the key expires, the client already has the value it needs to show "last seen 10:15".

### TTL?
TTL is the mechanism, not a hygiene trick — typically **30–60 seconds** matching the heartbeat interval. Clients re-`SET` with `EX 60` on every message/keypress, so a graceful "go offline" can be an explicit `DEL`. Rule of thumb: TTL slightly *longer* than the heartbeat interval (to tolerate one lost heartbeat) but short enough that a crashed client goes offline within a minute.

### Key design?
`presence:<userId>` — one key per user, never a giant hash of all users (that would be one hot key and one enormous value). Presence is sharded naturally by user ID. Never `SCAN` for online users; if you need "which of my contacts are online", ask their keys directly with `MGET`/`pipeline`, limited to the contact list.

### Consistency?
Presence is **inherently approximate** and you should say so out loud in an interview. Clock skew between app servers, a phone losing signal, a laptop suspended overnight, a GC pause — all produce wrong states that no consistency model fixes. Guarantee only: *if the key exists, the client was alive within the last 60 seconds*. `lastseen` in the DB is written on disconnect/periodically and can lag. Do not promise "exact online status"; promise "bounded staleness of one heartbeat interval".

### Failure modes?
- **Redis down:** every presence check fails. Decide up front: *fail open* (show everyone as offline / unknown — safe for chat, wrong for "is typing") or *fail closed*. Most products show a degraded state rather than blocking message send.
- **Reconnect storm:** app restarts and 10M clients heartbeat at once → spread heartbeats with jitter (`EX 45 + rand(0..15)`).
- **Key leak:** if the heartbeat is `SET` without `EX`, offline users stay "online" forever. This is the number-one presence bug.

### Scaling?
Presence is a pure key/value workload — one instance handles hundreds of thousands of ops/sec. Shard by `userId` hash when you outgrow one node; reads and writes for the same user land on the same shard, so there is no coordination. The fan-out of presence *changes* is the expensive part: use **Pub/Sub** (or Redis 7 sharded Pub/Sub) so only the user's contacts receive the event, and never poll presence in a loop.

### Interview follow-ups
**Q: Why not store presence in Postgres?** A: You would need a sweeper job scanning for stale rows and an `UPDATE` on every heartbeat — 60k writes/sec of pure noise against your source of truth.

**Q: Is presence exactly-once?** A: No, and nobody cares. It is a liveness hint with a 60-second staleness bound.

**Q: What about "last seen today" privacy settings?** A: Filtering happens at read time in the API; Redis stores raw facts, the product decides what to reveal.

**Q: How do you show online status to many viewers efficiently?** A: On connect, `MGET presence:<id1> ... presence:<id50>` in one round trip, then subscribe to presence changes over Pub/Sub.

## 4. API rate limiter

### Architecture
```
                    +---------------------------+
   Client  ------>  |  API gateway (N stateless |
                    |  nodes, no local state)   |
                    +-------------+-------------+
                                  |  INCR / EXPIRE / Lua
                                  v
                            +-----------+
                            |   Redis   |   single shared counter
                            +-----------+
                                  |
                    count <= limit ?  200 OK  :  429 Too Many Requests
```

### Why Redis?
N gateway nodes must agree on **one** counter. Each node counting locally would let one user get N× the limit (10 nodes × 100 req/min = 1000). Redis gives a shared atomic counter: `INCR` executes in Redis's single thread, so concurrent increments from 10 nodes are never lost — unlike `read -> x+1 -> write` in app code, which loses updates across processes. One round trip (~0.2 ms) per request is acceptable for a gate that rejects most abusive traffic anyway.

### What data goes in Redis?
```text
rl:<userId>:<windowId>   ->  "41"                (fixed window counter)
rl:tok:<userId>          ->  "18.5"              (token bucket remaining tokens)
```

Fixed-window is two commands (`INCR`, then `EXPIRE` on first hit). Token bucket stores `{tokens, lastRefillMs}` and is updated atomically with a small Lua script so refill + deduct cannot interleave.

### TTL?
**Mandatory, and it equals the window.** `EXPIRE rl:<user>:<window> 60`. Without it, every user ever seen leaves a key behind and memory grows forever. Two gotchas: (1) `INCR` then a *separate* `EXPIRE` can be lost if the process crashes in between — make it atomic with `SET key 0 EX 60 NX` first, or one Lua script; (2) only set the expiry when the counter is 1, otherwise every request pushes the window forward and the limit never resets.

### Key design?
Put the **window ID inside the key**: `rl:<user>:<floor(now/60)>`. Old windows then expire on their own and never collide with the current one. Keys must include the identity being limited (user, API key, IP) *and* the route bucket if limits differ per endpoint. Never use one global key — it is both a hot key and a correctness bug (everyone shares one limit).

### Consistency?
The limit is **approximate by design** and you should say that. Fixed windows allow a 2x burst across a boundary (99 requests at :59 + 99 at :01 in a 100/min limit). A sliding-window log is exact but stores every timestamp — memory grows with request rate. Also: the answer is only as consistent as your Redis; a failover with async replication can lose the last few increments, which means a few extra requests get through. Rate limiting is a *protection heuristic*, not a billing system.

### Failure modes?
- **Redis down:** decide *fail-open* (allow traffic — protects availability, limits become decorative) vs *fail-closed* (429 everything — protects the downstream, kills the product). Usually fail-open with a circuit breaker and log loudly.
- **Expiry never set:** memory exhaustion; looks like a leak, is actually a bug in your `INCR`/`EXPIRE` pair.
- **Hot key:** one abusive IP hammering one key → single shard. Mitigate with local pre-allocation (each node keeps a private budget of 10 and only syncs to Redis periodically).
- **Clock:** window math uses the app server's clock; keep it in UTC and NTP-synced.

### Scaling?
One Redis handles ~100k `INCR`s/sec, i.e. easily 100k+ limited requests/sec. Beyond that: shard limit keys by user ID (each user's counter lives on one shard — no cross-shard math needed). To cut Redis load further, do the cheap check locally first (process-local token bucket) and only consult Redis when the local budget is spent. That turns 1 Redis call per request into ~1 per 20 requests.

### Interview follow-ups
**Q: Fixed window, sliding window, or token bucket?** A: Fixed window = 2 commands, bursty at boundaries. Sliding window log = exact, memory-heavy. Sliding window *counter* = weighted mix, good default. Token bucket = allows controlled bursts, best for APIs.

**Q: Where does this run — app or gateway?** A: Gateway/edge, before the app, so abusive traffic never reaches your business logic or DB.

**Q: How do you return "retry after"?** A: `TTL rl:<user>:<window>` gives seconds until reset — one call, no clock math.

**Q: Is the counter exactly the number of requests?** A: No — retries, lost responses, and failover make it approximate. It needs to be *good enough to protect*, not audited.

## 5. E-commerce product cache

### Architecture
```
  Browser --> [ Web / BFF ] --> [ Product API ] ----> Redis  --hit----> JSON response
                                                     |
                                                   miss|
                                                     v
                                                  PostgreSQL  --row--> SET product:<id> EX 300
```

### Why Redis?
Product pages are the **read-heaviest** surface of the store: a catalog browse fires dozens of product fetches per page view. Postgres does 3–15 ms per row lookup with joins (price, stock, images, reviews summary); Redis returns a pre-serialized payload in ~0.2 ms. At 5k req/s that is the difference between 20 DB connections saturated and 2 connections mostly idle. You are not making the DB faster — you are making most requests never reach it.

### What data goes in Redis?
```text
product:1042            ->  JSON of the full product card   (the common case)
product:1042:stock      ->  "17"                            (volatile, hot)
catalog:page:3          ->  JSON array of 48 products       (list-page cache)
```

Cache the **serialized response you are about to send**, not a half-assembled object — that removes JSON.stringify work on the hot path. Fields that change per second (stock, flash-sale price) get their own short-lived keys instead of invalidating the whole product blob on every stock tick.

### TTL?
Yes — **60 s to 10 min** for product data, with **jitter**: `EX 300 + random(0..60)`. The jitter matters: if 50k keys were written in the same second and all expire together, they all miss together and the DB gets a thundering herd (cache avalanche). TTL *bounds staleness*: worst case a price change is invisible for 300 s. That is a product decision, not a technical one — which is why the fast-moving fields get a shorter TTL plus explicit invalidation.

### Key design?
`product:<id>` — colon-separated namespace, entity type, then the ID. Never `product:sku:1042` and `p:1042` in different services (you cannot `SCAN`-clean one namespace predictably). Keep one key per aggregate you render, not one key per database column (that turns every page view into 15 round trips — use `MGET`/pipeline if you must split). Include a version or schema marker (`product:v2:1042`) if the serialized shape ever changes, so old-format entries expire naturally instead of crashing `JSON.parse`.

### Consistency?
Postgres is the source of truth; Redis holds a copy with a bounded lifetime. **On write: update the DB, then `DEL product:<id>`** (delete-on-write, see `npm run cache:invalidation`). Delete rather than update-in-place because two concurrent writers can race and the slower "update" overwrites the newer row. Residual staleness windows: between the DB commit and the `DEL`, and if the `DEL` fails, until the TTL expires — which is exactly why TTL still exists even when you invalidate.

### Failure modes?
- **Stampede:** key expires, 5,000 concurrent readers all miss and hit the DB. Fix: per-key recompute lock with `SET ... NX` or probabilistic early refresh (see `npm run pattern:stampede`).
- **Penetration:** attackers request `product:999999999` which never exists → every request reaches the DB. Fix: negative cache `SET product:999999999 "" EX 30` (see `npm run cache:negative`).
- **Avalanche:** mass simultaneous expiry → add TTL jitter (see `npm run pattern:avalanche`).
- **Redis down:** degrade to direct DB reads with a circuit breaker; the store still works, just slower.

### Scaling?
Reads scale with **replicas** first (cheap, no rearchitecture). Memory scales with catalog size — a 10M-SKU catalog at ~1 KB per product is ~10 GB with overhead, which fits one node; beyond that shard by `product:<id>` hash. Add a tiny in-process LRU in front of Redis for the top 1k products (see `npm run pattern:hot-key`) to absorb the viral-product spike that would otherwise pin one Redis shard.

### Interview follow-ups
**Q: Cache-aside or write-through?** A: Cache-aside — the app owns the logic, and a cold cache is just a series of misses. Write-through adds a synchronous Redis write to every product update for little gain here.

**Q: Why not cache in the browser?** A: You do both — HTTP `Cache-Control`/CDN for anonymous public pages, Redis for the authenticated/personalized layer the CDN cannot cache.

**Q: How do you know the cache is working?** A: Hit ratio (`hit / (hit + miss)`) from `INFO stats` or `redis-cli INFO stats`, plus DB QPS before/after. Target >95% for this workload; below ~90% you are paying for Redis *and* the DB.

**Q: A price changes — how fast do users see it?** A: Depends on your invalidation: delete-on-write = milliseconds (if the `DEL` succeeds), TTL-only = up to the TTL. For flash sales, invalidate explicitly and keep the price in a separate short-TTL key.

## 6. Notification system

### Architecture
```
  Order service   ──XADD──>  Redis Stream  "notify:pending"   ──>  consumer group
                                                                  ├──> Worker1 -> FCM (push)
                                                                  ├──> Worker2 -> SES (email)
                                                                  └──> Worker3 -> webhook
  (durable fallback: PostgreSQL table / Kafka for business-critical notifies)
```

### Why Redis?
Notifications must not block the request that triggered them — "payment succeeded" should return in 50 ms while the email goes out over the next 2 seconds. A queue inside Redis decouples producer from deliverer, absorbs bursts (Black Friday: 10x normal volume in a 60-second window), and lets you run 20 delivery workers independently of the 3 API nodes. Lists give you a simple queue; **Streams + consumer groups** give you the same queue with acks, retries, and per-consumer history — which is what you want once delivery failures are possible.

### What data goes in Redis?
```text
notify:pending          STREAM   {userId, type, payload, idemKey}
notif:<userId>:unread   INT      INCR on delivery, read resets / DECR
notif:<notifId>         HASH     {type, body, readAt}   (for the in-app inbox)
```

Delivery channels are separate streams or separate `type` fields so a slow email provider cannot block push notifications.

### TTL?
Mixed, and it is worth stating precisely:

- The **queue itself: no TTL.** A message that expires before a worker picks it up is a lost notification.
- Bound the stream with **`MAXLEN ~ 100000`** instead — that caps memory while keeping only the newest messages, and you accept that an overflow drops the oldest (usually fine for marketing email, unacceptable for password resets).
- **Payload / inbox records: TTL 7–30 days** so the inbox does not grow forever.
- Use a **dead-letter stream** (`notify:dlq`) with its own retention (e.g. 7 days) for messages that keep failing.

### Key design?
Stream name = queue name; job details live in the stream entry fields, not in a separate key you might forget to write. Give every notification an **idempotency key** (`idem:<userId>:<eventId>`) so a redelivery does not send the same push twice — you will get redeliveries, this is not optional. Keep per-user ordering requirements explicit: if order matters per user, have one consumer group per shard-of-users rather than assuming global order.

### Consistency?
Delivery is **at-least-once**: a worker can crash after sending the push but before `XACK`, and the message will be redelivered. So the honest contract is "the user receives it at least once, possibly twice" — which is why clients dedupe by notification ID. What Redis does *not* promise here: if you run without AOF/RDB, a Redis restart with a full queue loses undelivered notifications. For anything a user would notice (security alerts, order confirmations), the source of truth event must also live in Postgres/Kafka, with the Redis queue as a fast buffer you can rebuild from.

### Failure modes?
| Failure | Result | Fix |
|---|---|---|
| Worker crashes mid-message | message stays in `XPENDING` | `XAUTOCLAIM` / `XCLAIM` after a visibility timeout |
| Message always fails (bad token) | blocks the retry loop forever | max-attempts counter → `XADD notify:dlq` |
| Redis restarts, no persistence | queue empty, notifications gone | AOF `appendfsync everysec` + rebuild from DB |
| Downstream provider slow | consumer lag grows | more workers, and shed load for low-priority types |
| Duplicate delivery | user gets 2 emails | idempotency key on the delivery side |

### Scaling?
Consumer groups are the scaling lever: **N workers in one group share the stream**, each message going to exactly one consumer in the group (`XREADGROUP GROUP notify workers COUNT 10 BLOCK 2000`). Add workers until lag (`XPENDING` count) is zero. Shard the stream by user ID when a single stream becomes a hot key — 10 streams × 10 workers beats 1 stream × 100 workers because it reduces contention and lets you scale per channel type.

### Interview follow-ups
**Q: Stream or Pub/Sub for notifications?** A: Pub/Sub drops messages when the subscriber is disconnected — fine for "typing…", wrong for "your order shipped". Streams retain until acked.

**Q: Redis or Kafka?** A: Kafka if notifications are part of a larger event platform with retention and replay requirements. Redis Streams if you want a simple durable-ish queue inside the system you already operate. Different scale and different ops burden — see the main README comparison.

**Q: How do you avoid emailing a user who just uninstalled the app?** A: Re-check the preference flag from the DB/cache *at delivery time*, not at enqueue time.

**Q: What is your delivery SLA?** A: Measure end-to-end: enqueue timestamp → delivery timestamp, and alert on consumer lag. Lag, not throughput, is the metric that tells you a worker pool is falling behind.

## 7. Job processing queue

### Architecture
```
  +---------+  XADD jobs:q   +-------------------+  XREADGROUP   +-----------+
  |  API    | -------------> | Redis             | <------------ | Worker ×N |
  | (enqueue)|               |  jobs:q  (stream) |               +-----------+
  +---------+                |  job:<id> (HASH)  |                    |
                             |  jobs:dlq         |                    v
                             +-------------------+              writes job:<id>:result
```

### Why Redis?
You need a queue where producers and consumers scale independently: a burst of 10,000 image-resize jobs should not slow down HTTP responses, and adding a 5th worker should not require touching the producer. Redis gives you that with `LPUSH`/`BRPOP` (simple) or **Streams + consumer groups** (ack, retry, pending list) at sub-millisecond latency, using infrastructure you already run. For a small/medium system this replaces a dedicated broker for a fraction of the operational cost.

### What data goes in Redis?
```text
jobs:q                STREAM   {jobId, type, payload, attempts}
job:<jobId>           HASH     {status, attempts, createdAt, error}
job:<jobId>:result    STRING   JSON result (written on success)
job:dlq               STREAM   jobs that exhausted retries
```

The `job:<id>` HASH is what the client polls (`HGET job:abc status`). Keeping status separate from the queue entry means the queue stays small while job metadata remains queryable.

### TTL?
- **Queue: no TTL.** Never let an unprocessed job expire.
- **`job:<id>` HASH and `job:<jobId>:result`: TTL 24 h – 7 days** (`EXPIRE`), so completed jobs do not accumulate forever. Set the TTL when the job is *created* (or refreshed on completion) — not only after success, or failed jobs leak forever.
- Clean up with `MAXLEN` on the stream for the log portion; the authoritative "did this job run" record is the HASH.

### Key design?
Job ID = UUIDv4 generated by the producer (so the producer can hand the ID to the client *before* the worker runs). One queue per job **type** (`jobs:resize`, `jobs:email`) if types have very different costs — otherwise a slow job type starves the fast one. `attempts` lives in the stream entry so the redelivery counter travels with the message.

### Consistency?
**At-least-once.** A worker that finishes the work and crashes before `XACK` gets the job again — so the job handler must be **idempotent** (resize the same file to the same output, `SET` a deterministic result key). Status transitions must be atomic relative to the queue move: write `job:<id> status=running` with `HSET` before acking, so a crash leaves a visible "running but stale" record that a reaper can reclaim. The DB remains the source of truth for anything the job mutates.

### Failure modes?
- **Poison message:** a payload that always throws. Without a cap, retries spin forever and one consumer is permanently stuck. Fix: increment `attempts`, and after N (e.g. 5) `XADD jobs:dlq` + `XACK` the original.
- **Worker crash:** messages sit in `XPENDING`; a periodic `XAUTOCLAIM` with an idle-time > expected runtime reclaims them.
- **Lost enqueue:** `LPUSH` without persistence + Redis restart = job never existed. Use AOF, and for business-critical jobs write the intent to Postgres first and treat Redis as the dispatcher.
- **Head-of-line blocking:** one huge job type in a shared queue. Separate streams per type.
- **Redis down:** producer retries with backoff or spills to a DB table; do not silently drop.

### Scaling?
Scale workers horizontally inside one consumer group — each message goes to exactly one worker, so adding workers linearly increases throughput until Redis or the downstream dependency saturates. Scale producers freely; `XADD` is O(1). When one stream becomes a hot key, shard into `jobs:q:0..N` and pick by hash. If jobs need strict ordering, per-key ordering, 30-day retention, or exactly-once semantics — that is the point where you say "this is Kafka's job, not Redis's".

### Interview follow-ups
**Q: List or Stream?** A: `LPUSH`/`BRPOP` is the smallest possible queue but gives you no ack — `BRPOP` removes the item the instant you read it, so a crash loses the job. Streams keep the item until `XACK`.

**Q: How do you know a job succeeded?** A: Worker writes `job:<id>` status + result, then `XACK`. Client polls the HASH or subscribes to a completion channel.

**Q: What happens when a worker is 10x too slow?** A: Lag grows in `XPENDING`; alert on pending count, add workers, and if the cause is one slow job type, split the stream.

**Q: Exactly-once?** A: Not provided by the queue. You get at-least-once delivery *plus* idempotent handlers, which is operationally what everyone means by exactly-once.

## 8. Leaderboard

### Architecture
```
  Game server  --ZADD lb:chess s1500 u7-->  +-------------------+
  Game server  --ZINCRBY lb:chess 12 u7-->  | Redis ZSET        |
                                             | member = userId   |
  API  <--ZRANGEBYSCORE lb:chess 0 -1 LIMIT |-- score = rating   |
        (top 10, or ZRANK for one player)   +-------------------+
                                                      |
                                            periodic snapshot (PG)
```

### Why Redis?
A sorted set is purpose-built for this: `ZADD`/`ZINCRBY` in **O(log N)**, `ZREVRANGE` top-10 in **O(log N + M)**, `ZRANK user` in **O(log N)** — all with a single data structure. Implement it in SQL and every rank query becomes `SELECT RANK() OVER (ORDER BY score DESC)` over the whole table, or a self-join per player. With 1M players that is the difference between 0.3 ms and tens of milliseconds per request, at the cost of holding ~100–150 MB (see Scaling for the real number).

### What data goes in Redis?
```text
lb:chess              ZSET   member=userId  score=rating
lb:chess:snapshot     (optional) periodic copy for audit
user:7:profile        HASH   {name, country, avatar}   <- denormalized
```

Store **IDs in the ZSET and profiles in a HASH**. Rendering a top-10 page then needs one `ZRANGE` + one `HMGET` of 10 profile fields — not 10 joins. Keep the profile HASH pipelined and on a replica.

### TTL?
Normally **no TTL** — a leaderboard is durable state that players expect to persist across restarts. Exceptions: seasonal/event leaderboards (`EXPIRE lb:summer2026 7776000` = 90 days, then archive the top N to Postgres), practice boards, or test data. If you *do* set a TTL on a live board, losing it means losing everyone's rating — so snapshot to the DB first (or make the DB authoritative and Redis the read model).

### Key design?
One ZSET per game/mode/season: `lb:chess`, `lb:chess:season9`. Member must be the **stable user ID**, never the display name (names change, and duplicates collide). Score must be a single numeric value — if you need "rank by wins then by recency", encode a composite score (`wins * 1e10 + (maxTs - lastGameTs)`) or accept that Redis sorts by one field. Always paginate: `ZREVRANGE lb:chess 0 9 WITHSCORES`, never dump a 1M-member board.

### Consistency?
With a single primary, `ZADD`/`ZINCRBY` are atomic — two game servers updating the same player never lose an update (unlike `score = score + 1` read-modify-write across processes). Reads from a **replica** can lag by tens of milliseconds, so a player who just won might see their old rank for a moment — read-your-own-rank from the primary if that matters. The DB snapshot is eventually consistent and exists for durability/analysis, not for the live board.

### Failure modes?
- **Memory:** 1M members × (ID ~16 B + score 8 B + skiplist pointer overhead) ≈ **100–150 MB**; 100M members ≈ 15 GB and no longer fits comfortably. Plan a snapshot + archive strategy.
- **Failover with async replication:** the last few `ZINCRBY`s are lost → ratings drift. For anything with prizes, persist score changes to Postgres too.
- **One hot key:** every player on a server updates `lb:chess` → a single shard takes all writes. Mitigate by batching (`ZINCRBY` per game end, not per move) and reading from replicas.
- **Ties:** Redis breaks ties by member lexicographically; if your product needs a defined tie-break, encode it in the score.

### Scaling?
A single ZSET **cannot be split across cluster nodes without losing global rank** — that is the honest constraint. Options in order of simplicity: (1) keep it on one shard and batch writes; (2) shard by league/region (`lb:eu`, `lb:us`) and compute a global top-K by merging shard results; (3) approximate ranks at scale (FlashRank-style: exact top-K in Redis, approximate rank from a compressed sketch). Reads go to replicas; the expensive `ZRANGE` for a full page is pipelined with profile hydration.

### Interview follow-ups
**Q: How do you show "your rank" among 100M players?** A: `ZREVRANK lb:chess u7` — O(log N), no scan.

**Q: What if two players have the same score?** A: Same rank range in Redis's ordering (ties broken by member ID); define the product rule and encode it in the score if it must be exact.

**Q: Redis fails — do we lose the game results?** A: No, if the DB is also written. Redis is the live read/write index; the DB is the record.

**Q: How do you paginate past the top 100?** A: `ZREVRANGE key start stop WITHSCORES` with offsets, and cap the depth — nobody browses to rank 900,000.

## 9. Session management

### Architecture
```
  +--------+   Cookie: sid=a91f...    +---------------------------+
  | Client | ----------------------> | App instance 1..N (stateless)|
  +--------+                          +-------------+-------------+
                                                     |  GET / DEL / EXPIRE
                                                     v
                                              +-------------+
                                              |    Redis    |
                                              | sess:a91f.. |
                                              +-------------+
```

### Why Redis?
Without shared session storage, every app instance keeps sessions in its own memory and you need sticky load balancing — deploy a new node and a slice of users gets logged out. Redis gives all N instances **one shared, O(1) lookup** (~0.2 ms) and — critically — **automatic expiry**, so abandoned sessions clean themselves up instead of piling up in a table you must periodically `DELETE FROM`. Session reads happen on every authenticated request; latency here is on the hot path of your entire API.

### What data goes in Redis?
```text
sess:a91f3c...   ->  JSON/HASH  {userId, role, email, csrfToken, createdAt}
user:42:sessions ->  SET        {sid1, sid2}     (for "log out everywhere")
sessver:42       ->  INT        session version  (bump to revoke all)
```

Keep it to **claims, not the whole user object**. A 50 KB session blob read 50 times per page view is 2.5 MB/s of pure waste; fetch profile details from their own cache on demand.

### TTL?
Two clocks, and interviewers love this question:

- **Sliding expiry:** `EXPIRE sess:<sid> 1800` on every authenticated request — active users stay logged in indefinitely.
- **Absolute cap:** store `createdAt` inside the session and reject if `now - createdAt > 24h`, forcing a fresh login. Sliding-only means a stolen session cookie is valid forever.

Without TTL you get unbounded growth *and* permanent sessions for people who never return — both are bugs.

### Key design?
Session ID must be a **256-bit random value** (`crypto.randomBytes(32).toString("base64url")`) — predictable IDs are session fixation. Prefix `sess:` so you can `SCAN MATCH sess:*` for admin tooling. Store only what is needed for authorization; anything user-specific-but-cacheable (preferences) belongs in `user:<id>:profile`, not duplicated into every session.

### Consistency?
Redis is the **session authority** for the tokens you issue — but the database remains the source of truth for *account state* (banned users, password changes, role changes). On logout: `DEL sess:<sid>` (plus remove from `user:<id>:sessions`). On "log out everywhere": delete the set members and bump `sessver:<userId>`, checking the version on every request — that is the cheap way to revoke without knowing all active session IDs. Because there is one primary, you will not see two conflicting values for the same session; reads from replicas may briefly lag after a write.

### Failure modes?
- **Redis down:** *everyone is logged out* — every request 401s. Mitigations: AOF persistence, replicas + failover, and a designed degradation (short-lived signed cookie as a fallback, or a DB read path) so an outage degrades to "slower login", not "site unusable".
- **Session fixation:** attacker sets a known session ID before login → always regenerate the ID on privilege change.
- **Stale revocation:** replica lag means a just-logged-out session might authenticate once or twice more — acceptable, but do not rely on logout for immediate security revocation without the version counter.
- **Big sessions:** serializing a bloated object on every request → keep sessions tiny.

### Scaling?
Sessions are sharded perfectly by `sess:<sid>` — each key is independent, no hot keys (a viral user has 2–3 sessions, not millions). Reads dominate, so **replicas** absorb most traffic; writes are only `EXPIRE` refreshes. At extreme scale, a local in-process LRU of session claims (10–30 s TTL) removes most Redis round trips — accept that logout may take up to that long to propagate. Sticky sessions are *not* required once sessions are externalized.

### Interview follow-ups
**Q: Redis sessions or JWT?** A: JWT = stateless, no Redis call, but revocation needs a denylist (which is a cache again) and every token carries claims. Sessions = instant revocation, one Redis GET. Most real systems use short-lived JWTs + refresh tokens in Redis.

**Q: What is the cost per request?** A: One `GET` (~0.2 ms). Pipeline it with other per-request cache reads to keep it at one round trip.

**Q: Do you store the whole user in the session?** A: No — only authorization claims. Profile data is fetched from its own cache so a profile update does not require rewriting every session.

**Q: What happens on a Redis failover?** A: With AOF/replica, a sub-second blip; sessions survive. Without persistence, every session evaporates and all users must log in again — no data loss beyond convenience, but plan for the thundering herd on `/login`.

## 10. Property survey processing pipeline (Taurgo-style)

### Runnable lab example
The repo contains a miniature version of a real ingestion pipeline in `src/streams/taurgo-survey.ts`.

**Flow:** a property survey is uploaded → an API/producer writes it to a Redis Stream with `XADD survey-events` → an AI worker loop reads with `XREADGROUP` inside a consumer group, runs *fake* processing (standing in for an AI/inference service), then acknowledges with `XACK` → the result is stored so it can be read back.

```
  Producer (survey uploaded)
        |
        |  XADD survey-events * propertyId ... fields ...
        v
  +---------------------------------+
  | Redis Stream: survey-events     |
  |  1728392001152-0                |
  |  1728392002847-0                |
  +---------------------------------+
        |  group "survey-workers"  (XREADGROUP ...)
        v
  +-----------+   +-----------+   +-----------+
  |  Worker1  |   |  Worker2  |   |  Worker3  |
  | XREADGROUP|   | XREADGROUP|   | XREADGROUP|
  | process   |   | process   |   | process   |
  |  (fake AI)|   |  (fake AI)|   |  (fake AI)|
  |   XACK    |   |   XACK    |   |   XACK    |
  +-----------+   +-----------+   +-----------+
        |
        v
  result stored (readable after processing)
```

**Run it:**

```bash
npm run stream:taurgo
```

You will see the producer append entries, the consumer group split them across reads, processing happen, `XACK` clear them from the pending list, and the stored results printed at the end.

**How this maps to production:** in a real system the "fake processing" step is an actual AI/inference service (a model API that takes 200 ms–20 s per survey), and the worker calls it over HTTP/gRPC. Production adds four things this lab deliberately skips: **retries** — if the model call fails, do *not* `XACK`; leave the message in the pending list and reclaim it with `XAUTOCLAIM` after a visibility timeout, incrementing an `attempts` field; **a DLQ** — after N failed attempts, `XADD survey-events:dlq` and ack the original so one poison survey cannot block the group forever; **idempotency** — workers may see the same survey twice, so write results to a deterministic key (`survey:<id>:result`) rather than appending blindly; and **multiple workers** — the consumer group already guarantees one consumer per message, so scaling out means starting more worker processes. You would also monitor **consumer lag** (count of pending entries per group) and alert when it grows, because lag is the signal that workers cannot keep up with survey uploads.

### Architecture
```
  Survey upload -> [ API ] -> Redis Stream -> AI worker group -> result store
                                  ^                |
                                  |    XACK        v
                            pending list     Redis key / PostgreSQL row
```

### Why Redis?
Ingestion is bursty (a surveyor's van uploads 200 properties at once when it gets signal) and processing is slow (AI inference). Without a buffer, the API must either reject uploads or hold the HTTP request open for minutes. A Redis Stream sits in the middle: `XADD` is O(1) and returns in under a millisecond, so the upload succeeds instantly, and workers drain at their own pace with visibility into exactly what is unprocessed.

### What data goes in Redis?
```text
survey-events                  STREAM  {propertyId, surveyorId, url, ts}
survey:<propertyId>:result     STRING/HASH   final AI output (with TTL)
survey:<propertyId>:status     STRING  queued|processing|done|failed
```

Payloads should reference storage (a URL to the survey blob), not contain megabytes of image data — Redis is not a file store.

### TTL?
- **Stream: no TTL** (unprocessed work must never vanish); bound it with `MAXLEN ~` instead.
- **`survey:<id>:result`: TTL 7–30 days** — results are large and append-only useful; the durable copy goes to Postgres/object storage.
- **Status keys: short TTL (1 h)** once done, so the hot namespace stays small.
- Reclaim timers for stuck messages come from `XPENDING`'s idle time, not from key expiry.

### Key design?
Stream name is the queue; one consumer group (`survey-workers`) per processing tier so you can add workers without changing producers. Result keys are keyed by `propertyId` — that natural idempotency key makes redelivery safe. Keep `status` as a separate key so the upload API can answer "is my survey done?" with one `GET` instead of scanning the stream.

### Consistency?
At-least-once delivery with idempotent writes. The upload API must `XADD` *after* accepting the file (or in the same logical transaction with a retry), because a lost enqueue means a survey that never gets processed — for that case, reconcile from the source-of-truth table of uploads. A message that is read but not acked is still owned by the group (visible in `XPENDING`), so a crash leaves recoverable state, not silent loss.

### Failure modes?
- **Worker crash mid-survey:** entry stays pending → `XAUTOCLAIM` reassigns it after the idle threshold.
- **Model service down:** nothing acks, pending grows — alert on lag; optionally park the batch and resume.
- **Poison survey** that always crashes the parser: attempts counter → DLQ stream, never block the group.
- **Redis restart without persistence:** the queue is gone; rebuild from the upload table (another reason the DB stays authoritative).
- **Duplicate processing:** handled by idempotent result keys.

### Scaling?
More workers = more throughput, thanks to the consumer group (each message to exactly one consumer). When one stream becomes a hot key or you need per-region ordering, shard into `survey-events:<region>`. CPU-heavy AI work should *not* run inside Redis-connected processes at full tilt — keep workers I/O-bound on the Redis side and offload inference to a dedicated service. If you later need multi-day retention, replay, and dozens of independent consumer types, that is when you graduate to Kafka — Streams is the right tool until it isn't.

### Interview follow-ups
**Q: Why a stream instead of a list?** A: A list (`BRPOP`) deletes the item on read — a crashed worker loses the survey. Streams keep it pending until `XACK`.

**Q: How do you know processing finished?** A: `XACK` removes it from `XPENDING`, and `survey:<id>:status` flips to `done`. Monitor pending count as lag.

**Q: What if the same survey is uploaded twice?** A: Dedupe on upload with an idempotency key, and let the result key (`survey:<propertyId>:result`) make the second processing a harmless overwrite.

**Q: How far behind is the pipeline right now?** A: `XPENDING survey-events survey-workers` (and its `IDLE`/count fields) — plus the age of the oldest pending ID versus now.
