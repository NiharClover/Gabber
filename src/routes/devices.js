const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { normalizeDeviceTokens } = require("../utils/deviceTokens");

const router = express.Router();
router.use(requireAuth);

// POST /api/devices/register
router.post("/register", async (req, res) => {
  const normalized = normalizeDeviceTokens(req.body);
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of normalized.tokens) {
        await client.query(
          `INSERT INTO device_tokens (user_id, push_token, provider, platform, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id, push_token) DO UPDATE
           SET provider = EXCLUDED.provider,
               platform = EXCLUDED.platform,
               updated_at = NOW()`,
          [req.user.userId, item.token, item.provider, item.platform]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true, registered: normalized.tokens.map(({ provider, platform }) => ({ provider, platform })) });
  } catch (err) {
    console.error("[devices]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

router.get("/notification-preferences", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT hide_sender_name FROM notification_preferences WHERE user_id=$1",
      [req.user.userId]
    );
    res.json({ hideSenderName: result.rows[0]?.hide_sender_name === true });
  } catch (err) {
    console.error("[devices:notification-preferences]", err.message);
    res.status(500).json({ error: "Could not load notification preferences." });
  }
});

router.put("/notification-preferences", async (req, res) => {
  if (typeof req.body.hideSenderName !== "boolean") {
    return res.status(400).json({ error: "hideSenderName must be a boolean." });
  }
  try {
    await pool.query(
      `INSERT INTO notification_preferences (user_id, hide_sender_name, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET hide_sender_name=EXCLUDED.hide_sender_name, updated_at=NOW()`,
      [req.user.userId, req.body.hideSenderName]
    );
    res.json({ hideSenderName: req.body.hideSenderName });
  } catch (err) {
    console.error("[devices:notification-preferences]", err.message);
    res.status(500).json({ error: "Could not save notification preferences." });
  }
});

module.exports = router;
