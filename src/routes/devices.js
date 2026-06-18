const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

// POST /api/devices/register
router.post("/register", async (req, res) => {
  const { pushToken } = req.body;
  if (!pushToken) return res.status(400).json({ error: "pushToken required." });
  try {
    await pool.query(
      `INSERT INTO device_tokens (user_id, push_token, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, push_token) DO UPDATE SET updated_at = NOW()`,
      [req.user.userId, pushToken]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[devices]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;