-- setup-db.sql
-- Run: npm run db:setup   (or: psql "$DATABASE_URL" -f scripts/setup-db.sql)
--
-- Everything in this lab is idempotent: you can run it as many times as you want.

-- 1. Products table -> the "source of truth" side of every caching example.
CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    price       INTEGER NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 2. Seed data so cache HIT / MISS demos are predictable.
--    (delete first so re-runs do not duplicate rows)
DELETE FROM products;

INSERT INTO products (id, name, price) VALUES
    (1, 'iPhone 17 Pro', 100000),
    (2, 'MacBook',       120000),
    (3, 'AirPods',       20000),
    (4, 'iPad',          55000),
    (5, 'Apple Watch',   2500);

-- Reset the sequence so the next INSERT gets id = 6.
SELECT setval('products_id_seq', (SELECT MAX(id) FROM products));

-- 3. Orders table -> used by the idempotency example (Part 18).
CREATE TABLE IF NOT EXISTS orders (
    id          SERIAL PRIMARY KEY,
    user_id     VARCHAR(50) NOT NULL,
    amount      INTEGER NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'created',
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

SELECT 'Database ready.' AS status;
