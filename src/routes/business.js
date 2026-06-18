const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

// POST /api/business/register
router.post("/register", async (req, res) => {
  const { name, type, phone, address, city, pincode, lat, lng, gstNumber } = req.body;
  if (!name) return res.status(400).json({ error: "Business name required." });
  try {
    // Check if user already has a business
    const existing = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "You already have a registered business." });
    }
    const id = `biz_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO businesses (id, user_id, name, type, phone, address, city, pincode, lat, lng, gst_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, req.user.userId, name, type || "general", phone, address, city, pincode, lat, lng, gstNumber]
    );
    res.json({ success: true, business: result.rows[0] });
  } catch (err) {
    console.error("[business]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/mine
router.get("/mine", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM businesses WHERE user_id = $1", [req.user.userId]);
    res.json({ business: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/:id
router.get("/:id", async (req, res) => {
  try {
    const biz = await pool.query("SELECT * FROM businesses WHERE id = $1", [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: "Not found." });
    const menu = await pool.query(
      "SELECT * FROM menu_items WHERE business_id = $1 AND available = true ORDER BY category, name",
      [req.params.id]
    );
    res.json({ business: biz.rows[0], menu: menu.rows });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/business/menu
router.post("/menu", async (req, res) => {
  const { name, description, price, category } = req.body;
  if (!name || !price) return res.status(400).json({ error: "name and price required." });
  try {
    const biz = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (!biz.rows[0]) return res.status(404).json({ error: "No business found." });
    const id = `item_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO menu_items (id, business_id, name, description, price, category)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, biz.rows[0].id, name, description, price, category || "General"]
    );
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/business/menu/:id
router.delete("/menu/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM menu_items WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/by-user/:userId
router.get("/by-user/:userId", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM businesses WHERE user_id = $1", [req.params.userId]);
    res.json({ business: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;    