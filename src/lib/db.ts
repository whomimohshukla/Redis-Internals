// src/lib/db.ts
// ---------------------------------------------------------------------------
// PostgreSQL pool = the SOURCE OF TRUTH.
// Redis is only a fast copy in front of it (see README Part 1).
//
// Pool (not one Client) because:
//   - Node is single threaded, many requests share a small pool of sockets
//   - Pool reuses connections instead of connecting per query
// ---------------------------------------------------------------------------

import "dotenv/config";
import { Pool } from "pg";

export const db = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/redis_learning",
});

db.on("error", (err) => {
  console.error("[pg] pool error:", err.message);
});
