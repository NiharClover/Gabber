const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

// POST /api/safety/block/:userId
router.post("/block/:userId", async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.userId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/safety/unblock/:userId
router.post("/unblock/:userId", async (req, res) => {
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

// GET /api/safety/blocked — list blocked users
router.get("/blocked", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.phone FROM blocked_users b
       JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1`,
      [req.user.userId]
    );
    res.json({ blocked: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/safety/is-blocked/:userId — check if either side blocked
router.get("/is-blocked/:userId", async (req, res) => {
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

// POST /api/safety/report/:userId
router.post("/report/:userId", async (req, res) => {
  const { reason, details } = req.body;
  if (!reason) return res.status(400).json({ error: "reason required." });
  try {
    const id = `report_${randomUUID().split("-")[0]}`;
    await pool.query(
      `INSERT INTO reports (id, reporter_id, reported_id, reason, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, req.user.userId, req.params.userId, reason, details || null]
    );

    // Auto-FLAG (never auto-suspend) accounts accumulating 3+ open reports
    // within 24h — just surfaces them at the top of the admin queue for
    // faster human review. A human always makes the actual call via
    // POST /api/admin/reports/:id/resolve.
    const recentOpen = await pool.query(
      `SELECT COUNT(*) AS cnt FROM reports
       WHERE reported_id = $1 AND status = 'open' AND created_at > NOW() - INTERVAL '24 hours'`,
      [req.params.userId]
    );
    if (parseInt(recentOpen.rows[0].cnt, 10) >= 3) {
      await pool.query(
        "UPDATE users SET flagged_at = NOW() WHERE id = $1 AND flagged_at IS NULL",
        [req.params.userId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[safety report]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;