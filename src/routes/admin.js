const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const pool = require("../db/pool");
const { multiBusinessOwners, verifiedOrderSpikes, reusedGstins } = require("../services/fraudSignals");

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

// GET /api/admin/businesses/pending
// Manual review checklist for the reviewer (not automated):
//   1. Cross-check the GSTIN on search.gst.gov.in — confirm active/registered,
//      note the registered legal name.
//   2. Compare registered legal name to the entered business name — flag
//      mismatches for follow-up, don't auto-reject (name variations happen).
//   3. Sanity-check registered business category vs. what they're listing.
//   4. Check uploaded address proof / storefront photo against entered
//      city/pincode.
router.get("/businesses/pending", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, name, type, phone, address, city, pincode,
              gst_number, verification_docs, verification_status, created_at
       FROM businesses
       WHERE verification_status = 'pending'
       ORDER BY created_at ASC`
    );
    res.json({ businesses: result.rows });
  } catch (err) {
    console.error("[admin businesses/pending]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/admin/businesses/:id/verify
// body: { approve: boolean, rejection_reason?: string, gstin_legal_name?: string }
//
// This is the ONLY place verification_status can move to 'verified' or
// 'rejected'. It intentionally has no knowledge of `plan` or payment state —
// do not add any payment/plan check to this route.
router.post("/businesses/:id/verify", async (req, res) => {
  const { approve, rejection_reason, gstin_legal_name } = req.body;

  if (typeof approve !== "boolean") {
    return res.status(400).json({ error: "approve (boolean) is required." });
  }
  if (!approve && !rejection_reason?.trim()) {
    return res.status(400).json({ error: "rejection_reason is required when rejecting." });
  }

  try {
    const status = approve ? "verified" : "rejected";
    const result = await pool.query(
      `UPDATE businesses
       SET verification_status = $1,
           verified_at = CASE WHEN $1 = 'verified' THEN NOW() ELSE verified_at END,
           verified_by = $2,
           rejection_reason = CASE WHEN $1 = 'rejected' THEN $3 ELSE NULL END,
           gstin_verified = CASE WHEN $1 = 'verified' THEN TRUE ELSE gstin_verified END,
           gstin_legal_name = COALESCE($4, gstin_legal_name)
       WHERE id = $5
       RETURNING id, name, verification_status, verified_at, verified_by, plan`,
      [status, req.user.userId, rejection_reason || null, gstin_legal_name || null, req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: "Business not found." });

    // Audit log — reviewer id + timestamp, per acceptance criteria.
    console.log(
      `[admin] Business ${req.params.id} (${result.rows[0].name}) marked '${status}' ` +
      `by admin ${req.user.userId} at ${new Date().toISOString()}`
    );

    res.json({ success: true, business: result.rows[0] });
  } catch (err) {
    console.error("[admin businesses/verify]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/admin/fraud-signals
// Non-blocking abuse signals for manual review — see services/fraudSignals.js.
router.get("/fraud-signals", async (req, res) => {
  try {
    const [owners, spikes, gstins] = await Promise.all([
      multiBusinessOwners(),
      verifiedOrderSpikes(),
      reusedGstins(),
    ]);
    res.json({
      multiBusinessOwners: owners,
      verifiedOrderSpikes: spikes,
      reusedGstins: gstins,
    });
  } catch (err) {
    console.error("[admin fraud-signals]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;