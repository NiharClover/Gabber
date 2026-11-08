const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const userId = req.user.userId;
  try {
    const [history, missed] = await Promise.all([
      pool.query(
        `SELECT ch.id, ch.call_type, ch.status, ch.started_at, ch.answered_at, ch.ended_at,
                CASE WHEN ch.caller_id=$1 THEN 'outgoing' ELSE 'incoming' END AS direction,
                CASE WHEN ch.caller_id=$1 THEN ch.callee_id ELSE ch.caller_id END AS other_user_id,
                peer.username AS other_username, peer.avatar_url AS other_avatar_url,
                CASE
                  WHEN ch.answered_at IS NOT NULL AND ch.ended_at IS NOT NULL
                  THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ch.ended_at-ch.answered_at))))::int
                  ELSE 0
                END AS duration_seconds
         FROM call_history ch
         JOIN users peer ON peer.id=CASE WHEN ch.caller_id=$1 THEN ch.callee_id ELSE ch.caller_id END
         WHERE ch.caller_id=$1 OR ch.callee_id=$1
         ORDER BY ch.started_at DESC
         LIMIT 200`,
        [userId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM call_history
         WHERE callee_id=$1 AND status='missed' AND missed_seen_at IS NULL`,
        [userId]
      ),
    ]);
    res.json({ calls: history.rows, missedCount: missed.rows[0]?.count || 0 });
  } catch (err) {
    console.error("[calls:list]", err.message);
    res.status(500).json({ error: "Could not load call history." });
  }
});

router.post("/mark-missed-seen", async (req, res) => {
  try {
    await pool.query(
      `UPDATE call_history SET missed_seen_at=NOW()
       WHERE callee_id=$1 AND status='missed' AND missed_seen_at IS NULL`,
      [req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[calls:mark-seen]", err.message);
    res.status(500).json({ error: "Could not update missed calls." });
  }
});

module.exports = router;
