const express = require("express");
const crypto = require("crypto");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

// Coturn's REST authentication scheme creates a short-lived username and
// HMAC credential. The shared secret stays on the server and is never shipped
// in the APK.
router.get("/ice-servers", (req, res) => {
  const secret = process.env.TURN_SHARED_SECRET;
  const host = process.env.TURN_HOST;
  if (!secret || !host) {
    return res.status(503).json({ error: "Call relay is not configured." });
  }

  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 60 * 60;
  const username = `${expiresAtSeconds}:${req.user.userId}`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");

  res.set("Cache-Control", "no-store");
  res.json({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      {
        urls: [
          `turn:${host}:3478?transport=udp`,
          `turn:${host}:3478?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
    expiresAt: expiresAtSeconds * 1000,
  });
});

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
