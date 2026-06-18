const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

// POST /api/blocks/:userId — block a user
router.post("/:userId", async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [req.user.userId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/blocks/:userId — unblock a user
router.delete("/:userId", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2",
      [req.user.userId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/blocks — get my blocked list
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.phone, bu.created_at AS blocked_at
       FROM blocked_users bu
       JOIN users u ON u.id = bu.blocked_id
       WHERE bu.blocker_id = $1
       ORDER BY bu.created_at DESC`,
      [req.user.userId]
    );
    res.json({ blocked: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/blocks/check/:userId — check if blocked (either direction)
router.get("/check/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        EXISTS(SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2) AS i_blocked_them,
        EXISTS(SELECT 1 FROM blocked_users WHERE blocker_id = $2 AND blocked_id = $1) AS they_blocked_me`,
      [req.user.userId, req.params.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/blocks/report/:userId — report a user
router.post("/report/:userId", async (req, res) => {
  const { reason, details } = req.body;
  if (!reason) return res.status(400).json({ error: "reason required." });
  try {
    const id = `report_${randomUUID().split("-")[0]}`;
    await pool.query(
      "INSERT INTO reports (id, reporter_id, reported_id, reason, details) VALUES ($1,$2,$3,$4,$5)",
      [id, req.user.userId, req.params.userId, reason, details || null]
    );
    console.log(`[report] ${req.user.username} reported user ${req.params.userId} for: ${reason}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;