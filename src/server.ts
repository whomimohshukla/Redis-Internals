import dotenv from "dotenv";

dotenv.config();

import express from "express";

import { db } from "./db";
import { redis, connectRedis } from "./redis";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

async function startServer() {
  await connectRedis();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();