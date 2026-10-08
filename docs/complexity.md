# Redis Big-O Cheat Sheet

Big-O here describes how a command's time and space grow as the data grows (N = elements in
the collection, M = elements returned/removed, V = value size in bytes). It is a *worst-case
asymptotic* model: it deliberately hides constants, memory layout and network cost. In
practice the network usually wins - five sequential O(1) round trips over a 0.5ms link cost
more wall-clock time than one O(log N) command on a million-element sorted set - so always
count round trips alongside the complexity. The second thing Big-O hides is that Redis is
single-threaded: one slow O(N) command in your request path delays *every* other client.

## 1. Command complexity table

Figures below are the official Redis documented complexities (redis.io / redis-doc), checked
against a real `commands.json`.

### Strings and keys

| Command | Time | Space | Notes |
|---|---|---|---|
| GET | O(1) | O(V) reply | Reply bytes still cross the network - O(1) is not "free" |
| SET | O(1) | O(V) | EX/PX/NX/XX flags are free; replaces the old value |
| SETNX | O(1) | O(V) | SET with NX; returns null when the key exists |
| GETSET | O(1) | O(V) | Set and return the old value atomically; prefer SET with GET on newer versions |
| DEL (one string key) | O(1) | O(1) | Freeing a big collection costs O(M) inside the command - use UNLINK |
| EXISTS (one key) | O(1) | O(1) | O(N) when many keys are passed in one call |
| EXPIRE | O(1) | O(1) | Lazy check on access plus server-side active expiry cycle |
| TTL / PTTL | O(1) | O(1) | -1 = no expiry, -2 = key does not exist |
| INCR / DECR | O(1) | O(1) | Atomic integer read-modify-write; 64-bit signed |
| INCRBY / DECRBY | O(1) | O(1) | Same as INCR with an explicit delta |
| MGET | O(N) | O(N) reply | N keys, one round trip; reply is N values |
| MSET | O(N) | O(N) | Whole call is one command (atomic as a unit) |

### Hashes

| Command | Time | Space | Notes |
|---|---|---|---|
| HGET | O(1) | O(V) reply | Single field lookup; hash keys stay small and fast |
| HSET | O(1) per pair | O(V) | O(N) when setting N pairs in one call; rehashing is amortized O(1) |
| HGETALL | O(N) | O(N) reply | N = every field in the hash; dumps the whole hash |
| HDEL | O(N) for N fields | O(1) | O(1) per field removed |
| HKEYS / HVALS | O(N) | O(N) reply | Whole-hash reads, same trap as HGETALL |
| HEXISTS / HLEN / HINCRBY | O(1) | O(1) | Cheap - prefer these over loading the hash |

### Lists

| Command | Time | Space | Notes |
|---|---|---|---|
| LPUSH / RPUSH | O(1) per element | O(V) | O(N) when pushing N elements in one call |
| LPOP / RPOP | O(1) per element | O(1) | O(N) when popping a count of elements |
| LRANGE start stop | O(S+N) | O(N) reply | S = distance from the nearest end, N = elements returned |
| LRANGE 0 -1 | O(N) | O(N) reply + wire | Full dump of the list - paginate with LRANGE i i+99 |
| LINDEX | O(N) | O(1) | O(1) at head or tail, O(index) in the middle |
| LLEN / LREM | O(1) / O(N+M) | O(1) | LLEN is free; LREM scans the list |

### Sets

| Command | Time | Space | Notes |
|---|---|---|---|
| SADD | O(1) per member | O(member) | O(N) when adding N members in one call |
| SREM | O(N) for N members | O(1) | O(1) per member removed |
| SISMEMBER | O(1) | O(1) | The reason sets exist: instant membership tests |
| SMEMBERS | O(N) | O(N) reply | N = cardinality; unbounded reply is the danger, not the time |
| SCARD | O(1) | O(1) | Count without transferring members |
| SPOP / SRANDMEMBER | O(1) without count | O(V) | O(N) when a count of N is requested |

### Sorted sets

| Command | Time | Space | Notes |
|---|---|---|---|
| ZADD | O(log N) per member | O(member) | O(N) for N members; skiplist + hash table |
| ZRANGE | O(log N + M) | O(M) reply | M = returned; with fixed M it is effectively O(log N) |
| ZREVRANGE | O(log N + M) | O(M) reply | Same cost as ZRANGE ... REV; keep both spellings in mind |
| ZRANK | O(log N) | O(1) | Ascending index (0 = lowest score); ZREVRANK is the mirror |
| ZSCORE | O(1) | O(1) | Member -> score straight from the hash table |
| ZCARD | O(1) | O(1) | Cardinality without touching scores |
| ZINCRBY | O(log N) | O(1) | Atomic score increment - the leaderboard update primitive |
| ZREMRANGEBYRANK | O(log N + M) | O(1) | M = members removed; how you cap a board's size |
| ZRANGEBYSCORE | O(log N + M) | O(M) reply | O(log N) when LIMIT caps M to a constant |

### Streams

| Command | Time | Space | Notes |
|---|---|---|---|
| XADD | O(1) | O(entry) | Plus O(evicted) when trimming fires; ~ trimming keeps that tiny |
| XREAD | O(M) per stream | O(M) reply | M = entries returned; blocking form makes XADD wake blocked clients |
| XLEN | O(1) | O(1) | Count without scanning the stream |
| XRANGE / XREVRANGE | O(N) | O(N) reply | N = elements returned; with fixed COUNT it is effectively O(1) |
| XACK | O(1) per id | O(1) | Removes the entry from the group's PEL |
| XPENDING (range) | O(N) | O(1) | N = entries returned; the summary form is O(1) for few consumers |
| XCLAIM | O(log N) | O(1) | N = size of the group's pending entries list |
| XAUTOCLAIM | O(1) | O(1) | With a small COUNT; larger COUNT scans more of the PEL |
| XTRIM | O(N) | O(1) | N = entries evicted; cheap because entries free in macro-nodes |

### Probabilistic, iteration and misc

| Command | Time | Space | Notes |
|---|---|---|---|
| PFADD | O(1) | O(12 KB) | HyperLogLog is a fixed ~12 KB structure (16384 x 6-bit registers) |
| PFCOUNT | O(1) single key | O(1) reply | O(N keys) with large constants when merging several HLLs |
| KEYS pattern | O(N) blocking | O(1) | N = every key in the DB; blocks the server - never in production |
| SCAN cursor | O(1) per call | O(1) | Full iteration is O(N) total across many calls; does not block |
| SORT | O(N + M log M) | O(M) reply | N = elements sorted, M = returned; BY/GET add lookups per element |
| GETSET | O(1) | O(V) | Covered above - listed again because interviews love it |

---

## 2. Caveats - complexity is not the whole story

- **Data size, not just element count.** `GET` is O(1), but fetching a 2 MB string moves
  2 MB over the wire; O(1) with a huge constant beats nothing.
- **Value size / serialization.** `JSON.stringify` of a 50 KB object plus Redis' own framing
  often costs more CPU than the dictionary lookup did. Store what you read, not whole rows.
- **Network round trips dominate.** A local RTT is ~0.1-0.5ms; ten sequential commands is
  10 RTTs of pure latency. Pipeline, `MGET`, or `EVAL` collapse them into one.
- **Worst case vs typical.** Big-O is the upper bound. A hash rehash, a skiplist with unlucky
  levels, or `SCAN` hitting a long bucket chain are rare spikes - measure, do not assume.
- **Redis is single-threaded.** One `HGETALL` over a 100k-field hash or a `KEYS *` stalls
  every other client on that instance; your O(1) reads queue behind it (watch p99).
- **Blocking vs async work.** Modern Redis moves the freeing cost off the critical path
  (`UNLINK`, lazyfree threads), so `DEL` of a huge key is O(1)-ish for callers while
  reclamation happens in the background.
- **Big keys and reply size.** An O(1) command that returns a giant value still costs CPU to
  serialize plus bandwidth; the reply, not the lookup, is usually the expensive half.
- **Redis version.** Complexities and recommended spellings move: `ZREVRANGE` -> `ZRANGE ...
  REV`, `DEL` -> `UNLINK` for big values, `SORT` -> `SORT_RO` for read replicas, `XAUTOCLAIM`
  only exists from 6.2.
- **Pipelining.** Cuts round trips (client + network) but the server still executes every
  command sequentially - pipeline hides latency, not server work - and big pipelines buffer
  replies in memory.
- **Workload mix.** A single occasional O(N) admin command among millions of O(1) commands
  is a latency spike for *everyone*; run scans and analytics on a replica instead.
- **N is a moving target.** `KEYS`/`SCAN` scale with total keyspace size; `SMEMBERS` scales
  with one collection's cardinality - know which N you are in.

## 3. Practical rules of thumb

- **Never `KEYS *` in production.** It is O(N) and blocks the event loop; iterate with
  `SCAN cursor COUNT 100` and let the cursor walk the keyspace in small slices.
- **Keep O(N) reads out of the request path when N is unbounded.** `SMEMBERS`, `HGETALL`,
  `LRANGE 0 -1` and `SORT` are fine for small, capped collections and dangerous otherwise -
  prefer `SSCAN`/`HSCAN`/paged `LRANGE`.
- **`HGETALL` on a 10k-field hash** returns 10k field/value pairs (huge reply, JSON parse
  cost). Fetch the two fields you need with `HMGET`.
- **`LRANGE 0 -1` on a million-element list** is O(N) plus megabytes on the wire; page with
  `LRANGE list 0 99`, then `100 199`, or keep the list trimmed with `LTRIM`.
- **Kill N+1 command patterns.** Looping `GET product:${id}` over 50 ids = 50 round trips;
  one `MGET` (or a pipeline) does the same work in 1 RTT - O(N) server work, O(1) latency.
- **Pipeline many small commands.** Rate-limit checks, `EXISTS` probes and metadata fetches
  batch into a single flight; keep batches small enough that the reply buffer stays sane.
- **Keep values small.** Store the fields you actually read (or a Redis hash of primitives),
  avoid giant JSON blobs, and shard hot mega-keys across several sub-keys.
- **Bound every collection by design.** `XADD MAXLEN ~`, `LTRIM`, `ZREMRANGEBYSCORE` for
  time windows, `EXPIRE` on whole keys - unbounded growth turns every later command O(N).
- **Count without loading.** `SCARD`, `ZCARD`, `LLEN`, `STRLEN`, `EXISTS` answer in O(1);
  loading data just to count it pays for the transfer too.
- **Think in p99, not averages.** One `SMEMBERS` of a 1M-member set per request makes every
  concurrent O(1) request wait behind it on the single thread.
- **Measure before optimizing.** `SLOWLOG GET`, `LATENCY LATEST`, `INFO commandstats` and
  `MEMORY USAGE key` turn these Big-O claims into numbers.

## 4. How this shows up in interviews

**Q1: "What is the complexity of `GET`, and is it really free?"**
A: O(1) - one hash-table lookup on the server. Not free end-to-end: you still pay a network
round trip plus transfer of the value bytes, so a 1 MB blob makes the *network* the cost
while the CPU stays flat.

**Q2: "Why is `KEYS *` banned in production, and what do you use instead?"**
A: `KEYS` is O(N) over the whole keyspace and runs in the single thread, so it blocks every
other client while it scans. Use `SCAN` with a cursor: O(1) per call, no blocking, the full
iteration still costs O(N) but spread over many small calls that interleave with normal
traffic.

**Q3: "Most of my commands are O(1), so why is p99 latency spiking?"**
A: Because of the occasional O(N) command - an `SMEMBERS`, `HGETALL` or `LRANGE 0 -1` on a
big key - which the single thread executes to completion while everything else queues. Check
`SLOWLOG GET`, then bound the read (scan/paging/field subsets) or run it against a replica.

**Q4: "`MGET` versus a loop of `GET`s - does it change the complexity?"**
A: Server-side it is the same O(N) work, but the loop costs N round trips and `MGET` costs
one, and `MGET` also gives you a consistent snapshot at one point in time. Latency, not
server CPU, is what `MGET` fixes.

**Q5: "You have 10 million players in a leaderboard - is `ZADD` O(log N) a problem?"**
A: No: log2(10M) is about 24 skiplist steps with tiny constants, and top-10 reads are
O(log N + 10). The practical constraint is memory for the skiplist nodes, plus knowing that
`ZINCRBY` on a hot member serializes on the single thread - shard or batch under extreme
write rates.

**Q6: "`LRANGE 0 -1` on a 1M-element list - what exactly hurts?"**
A: Time is O(S+N) with N = the entire list, and then you serialize and transfer a million
elements and parse them client-side. The complexity and the reply size compound - page the
range and keep the list trimmed instead.
