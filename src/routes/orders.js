const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

// POST /api/orders — create order
router.post("/", async (req, res) => {
  const { businessId, chatId, items, notes } = req.body;
  if (!businessId || !items || !items.length) {
    return res.status(400).json({ error: "businessId and items required." });
  }
  try {
    // Calculate total
    const itemIds = items.map((i) => i.id);
    const menuResult = await pool.query(
      "SELECT * FROM menu_items WHERE id = ANY($1)",
      [itemIds]
    );
    const menuMap = {};
    menuResult.rows.forEach((m) => { menuMap[m.id] = m; });

    let total = 0;
    const orderItems = items.map((item) => {
      const menuItem = menuMap[item.id];
      if (!menuItem) throw new Error(`Item ${item.id} not found`);
      const subtotal = menuItem.price * item.qty;
      total += subtotal;
      return { ...menuItem, qty: item.qty, subtotal };
    });

    const id = `order_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO orders (id, business_id, customer_id, chat_id, items, total, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, businessId, req.user.userId, chatId, JSON.stringify(orderItems), total, notes]
    );

    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error("[orders]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders — get my orders
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, b.name AS business_name FROM orders o
       JOIN businesses b ON b.id = o.business_id
       WHERE o.customer_id = $1
       ORDER BY o.created_at DESC`,
      [req.user.userId]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/orders/business — get orders for my business
router.get("/business", async (req, res) => {
  try {
    const biz = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (!biz.rows[0]) return res.status(404).json({ error: "No business found." });
    const result = await pool.query(
      `SELECT o.*, u.username AS customer_name FROM orders o
       JOIN users u ON u.id = o.customer_id
       WHERE o.business_id = $1
       ORDER BY o.created_at DESC`,
      [biz.rows[0].id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// PATCH /api/orders/:id/status
router.patch("/:id/status", async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["pending", "confirmed", "preparing", "ready", "delivered", "cancelled"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  try {
    await pool.query("UPDATE orders SET status = $1 WHERE id = $2", [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;