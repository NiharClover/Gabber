const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

// POST /api/contacts/sync
// Body: { phones: ["+919876543210", "+911234567890", ...] }
// Returns which of these numbers are registered on Gabber
router.post("/sync", async (req, res) => {
  const { phones } = req.body;

  if (!phones || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: "phones array required." });
  }

  try {
    // Normalize all numbers — strip spaces, dashes etc
    const normalized = phones
      .map((p) => p.replace(/[\s\-().]/g, ""))
      .filter((p) => p.startsWith("+") && p.length >= 10);

    if (normalized.length === 0) {
      return res.json({ contacts: [] });
    }

    // Find which of these are on Gabber
    const result = await pool.query(
      `SELECT id, username, phone, avatar_url, last_seen
       FROM users
       WHERE phone = ANY($1) AND id != $2`,
      [normalized, req.user.userId]
    );

    res.json({ contacts: result.rows });
  } catch (err) {
    console.error("[contacts] Error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;