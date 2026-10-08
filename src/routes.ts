import { Router } from "express";
import { db } from "./db";
import { redis } from "./redis";

const router = Router();

// ---- Ping ----
router.get("/ping", async (req, res) => {
	res.send("pong");
});

// ---- DB test ----
router.get("/db", async (req, res) => {
	try {
		const { rows } = await db.query("SELECT * FROM users");
		res.send(rows);
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "DB error" });
	}
});

// // // ---- Get product by id (Redis cache + Postgres) ----
// router.get("/products/:id", async (req, res) => {
//     try {
//         const { id } = req.params;
//         const cacheKey = `product:${id}`;

//         // 1. Check Redis first
//         const cachedProduct = await redis.get(cacheKey);
//         if (cachedProduct) {
//             console.log("CACHE HIT");
//             return res.json(JSON.parse(cachedProduct));
//         }

//         console.log("CACHE MISS");

//         // 2. Cache miss → query PostgreSQL
//         const result = await db.query(
//             "SELECT * FROM products WHERE id = $1",
//             [id]
//         );

//         if (result.rows.length === 0) {
//             return res.status(404).json({ message: "Product not found" });
//         }

//         const product = result.rows[0];

//         // 3. Store result in Redis (expires in 60s)
//         await redis.set(cacheKey, JSON.stringify(product), { EX: 60 });

//         // 4. Return response
//         res.json(product);
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ message: "Internal server error" });
//     }
// });

router.get("/products/:id", async (req, res) => {
	const { id } = req.params;
	const cacheKey = `product:${id}`;

	let cachedProduct = null;

	try {
		cachedProduct = await redis.get(cacheKey);
	} catch (error) {
		console.log("Redis unavailable");
	}

	if (cachedProduct) {
		console.log("CACHE HIT");
		return res.json(JSON.parse(cachedProduct));
	}

	console.log("CACHE MISS");

	const result = await db.query("SELECT * FROM products WHERE id = $1", [id]);

	if (result.rows.length === 0) {
		return res.status(404).json({
			message: "Product not found",
		});
	}

	const product = result.rows[0];

	try {
		await redis.set(cacheKey, JSON.stringify(product), { EX: 60 });
	} catch (error) {
		console.log("Could not update cache");
	}

	res.json(product);
});
router.put("/products/:id", async (req, res) => {
	const { id } = req.params;
	const { name, price } = req.body;

	// Update database
	const result = await db.query(
		`
    UPDATE products
    SET name = $1, price = $2
    WHERE id = $3
    RETURNING *
    `,
		[name, price, id],
	);

	if (result.rows.length === 0) {
		return res.status(404).json({
			message: "Product not found",
		});
	}

	// IMPORTANT:
	// Delete old cached value
	await redis.del(`product:${id}`);

	console.log("CACHE INVALIDATED");

	res.json(result.rows[0]);
});
export default router;
