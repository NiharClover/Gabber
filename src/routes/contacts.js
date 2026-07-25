const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

// SECURITY FIX: this endpoint tells the caller which phone numbers, out of
// any list they submit, are registered on Gabber. With no size cap and no
// rate limit, it was a phone-number enumeration oracle — an attacker could
// script large batches of generated/guessed numbers through this endpoint
// to build a database of "who has a Gabber account," which is a real
// privacy exposure independent of anything else in the app. A normal
// device contact sync is at most a few thousand numbers, so the cap below
// doesn't affect legitimate use.
const MAX_PHONES_PER_SYNC = 3000;

const contactsSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12, // generous for real usage (app syncs on load + manual refresh), tight for scripted enumeration
  keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req.ip),
  message: { error: "Too many contact syncs. Try again in a few minutes." },
});

// POST /api/contacts/sync
// Body: { phones: ["+919876543210", "+911234567890", ...] }
// Returns which of these numbers are registered on Gabber
router.post("/sync", contactsSyncLimiter, async (req, res) => {
  const { phones } = req.body;

  if (!phones || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: "phones array required." });
  }
  if (phones.length > MAX_PHONES_PER_SYNC) {
    return res.status(400).json({ error: `Too many numbers in one request (max ${MAX_PHONES_PER_SYNC}).` });
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