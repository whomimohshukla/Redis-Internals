// src/lib/redis.ts
// ---------------------------------------------------------------------------
// Single shared Redis client for the whole lab.
//
// WHY one shared client?
//   createClient() opens a TCP connection to Redis. If you call new Redis()
//   on every HTTP request you open thousands of connections ("connection
//   storm") and Redis (single-threaded) spends time just accepting sockets.
//   In real apps: create ONE client at startup, reuse it everywhere.
// ---------------------------------------------------------------------------

import "dotenv/config"; // must be the first import so process.env is loaded
import { createClient, type RedisClientType } from "redis";

// Fall back to localhost so every example runs even without a .env file.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redis: RedisClientType = createClient({ url: REDIS_URL });

// Without this handler, any transient Redis error crashes the Node process.
redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});

/** Connect once (idempotent - safe to call from any example). */
export async function connectRedis(): Promise<void> {
  if (!redis.isOpen) await redis.connect();
}

/** Close the connection cleanly so standalone scripts can exit. */
export async function closeRedis(): Promise<void> {
  if (redis.isOpen) await redis.quit();
}

/**
 * Standard lifecycle for every standalone example:
 *
 *   await withRedis(async () => { ...your demo... });
 */
export async function withRedis(fn: () => Promise<void>): Promise<void> {
  try {
    await connectRedis();
    await fn();
  } finally {
    await closeRedis();
  }
}
