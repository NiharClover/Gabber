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
       AND NOT EXISTS (
         SELECT 1 FROM blocked_users bu
         WHERE (bu.blocker_id=$1 AND bu.blocked_id=s.user_id)
            OR (bu.blocker_id=s.user_id AND bu.blocked_id=$1)
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
  const normalizedType = type || "text";
  const normalizedContent = typeof content === "string" ? content.trim() : "";
  const normalizedBgColor = typeof bgColor === "string" ? bgColor.trim() : "#ff6b35";
  if (!["text", "image"].includes(normalizedType)) return res.status(400).json({ error: "Invalid status type." });
  if (!normalizedContent) return res.status(400).json({ error: "content required." });
  if (normalizedType === "text" && normalizedContent.length > 2000) {
    return res.status(400).json({ error: "Text status must be 2,000 characters or fewer." });
  }
  if (normalizedType === "image" && (normalizedContent.length > 2048 || !/^https?:\/\//i.test(normalizedContent))) {
    return res.status(400).json({ error: "Image status must contain a valid uploaded image URL." });
  }
  if (!/^#[0-9a-f]{6}$/i.test(normalizedBgColor)) return res.status(400).json({ error: "Invalid background colour." });

  try {
    const id = `status_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO statuses (id, user_id, type, content, bg_color)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, req.user.userId, normalizedType, normalizedContent, normalizedBgColor]
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
    const result = await pool.query(
      `INSERT INTO status_views (status_id, viewer_id)
       SELECT s.id, $2 FROM statuses s
       WHERE s.id=$1 AND s.expires_at>NOW() AND s.user_id<>$2
         AND EXISTS (
           SELECT 1 FROM chat_members mine
           JOIN chat_members owner ON owner.chat_id=mine.chat_id
           WHERE mine.user_id=$2 AND owner.user_id=s.user_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users bu
           WHERE (bu.blocker_id=$2 AND bu.blocked_id=s.user_id)
              OR (bu.blocker_id=s.user_id AND bu.blocked_id=$2)
         )
       ON CONFLICT (status_id, viewer_id) DO UPDATE
       SET viewed_at=status_views.viewed_at
       RETURNING status_id`,
      [req.params.id, req.user.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Status not found or not visible to you." });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/status/:id — delete own status
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM statuses WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Status not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
