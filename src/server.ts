// src/server.ts
// The HTTP face of the lab. Run with:  npm start
//
// Endpoints:
//   GET  /products/:id      -> cache-aside (HIT / MISS)      [Part 5, 6]
//   PUT  /products/:id      -> cache invalidation            [Part 8]
//   POST /payments          -> idempotency with Redis        [Part 18]
//   GET  /rate/:userId      -> fixed-window rate limiter     [Part 17]
//   POST /views/:productId  -> atomic view counter (INCR)    [Part 16]
//
// Architecture:
//   Client -> Express -> Redis (fast copy)
//                      -> PostgreSQL (source of truth)

import "dotenv/config";
import express from "express";
import { connectRedis } from "./lib/redis";
import routes from "./routes";

const app = express();
app.use(express.json());
app.use(routes);

const PORT = Number(process.env.PORT ?? 3000);

async function start() {
  await connectRedis(); // fail fast if Redis is not running
  app.listen(PORT, () => {
    console.log(`\nRedis Caching Interview Lab -> http://localhost:${PORT}`);
    console.log("Try:");
    console.log("  curl http://localhost:3000/products/1   # watch the terminal");
    console.log("  curl http://localhost:3000/products/1   # CACHE HIT");
    console.log("  curl -X PUT http://localhost:3000/products/1 -H 'Content-Type: application/json' -d '{\"name\":\"iPhone 18\",\"price\":110000}'");
    console.log("");
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
