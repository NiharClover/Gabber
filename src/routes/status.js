const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

// GET /api/status — get all active statuses from contacts
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.username, u.avatar_url,
        COUNT(sv.viewer_id) AS view_count,
        MAX(CASE WHEN sv.viewer_id = $1 THEN 1 ELSE 0 END) AS viewed_by_me
       FROM statuses s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN status_views sv ON sv.status_id = s.id
       WHERE s.expires_at > NOW()
       AND (
         s.user_id = $1
         OR s.user_id IN (
           SELECT cm2.user_id FROM chat_members cm1
           JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
           WHERE cm1.user_id = $1 AND cm2.user_id != $1
         )
       )
       GROUP BY s.id, u.username, u.avatar_url
       ORDER BY s.created_at DESC`,
      [req.user.userId]
    );
    res.json({ statuses: result.rows });
  } catch (err) {
    console.error("[status]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/status — create a new status
router.post("/", async (req, res) => {
  const { type, content, bgColor } = req.body;
  if (!content) return res.status(400).json({ error: "content required." });

  try {
    const id = `status_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO statuses (id, user_id, type, content, bg_color)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, req.user.userId, type || "text", content, bgColor || "#ff6b35"]
    );
    res.json({ success: true, status: result.rows[0] });
  } catch (err) {
    console.error("[status]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/status/:id/view — mark as viewed
router.post("/:id/view", async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO status_views (status_id, viewer_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/status/:id — delete own status
router.delete("/:id", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM statuses WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;