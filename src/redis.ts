import { createClient } from "redis";

export const redis = createClient({
  url: process.env.REDIS_URL,
});

// Redis connection errors
redis.on("error", (err) => {
  console.error("Redis Error:", err);
});

// Connect to Redis
export async function connectRedis() {
  await redis.connect();
  console.log("Redis connected");
}