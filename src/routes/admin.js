const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const pool = require("../db/pool");
const { multiBusinessOwners, verifiedOrderSpikes, reusedGstins } = require("../services/fraudSignals");
const { getPrivateFileAccess } = require("../services/storage");
const { requireForensics } = require("../middleware/forensics");

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

// Resolve the disclosed opaque code visible on a leaked media copy. This is
// intentionally admin-only because it identifies the account that received
// that particular delivery.
router.get("/media-trace/:code", requireForensics, async (req, res) => {
  try {
    const code = String(req.params.code || "").toUpperCase();
    if (!/^GBR-[A-F0-9]{5}-[A-F0-9]{5}-[A-F0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: "Invalid trace code." });
    }
    const result = await pool.query(
      `SELECT t.trace_code, t.message_id, t.delivered_at,
              recipient.id AS recipient_id, recipient.username AS recipient_username,
              sender.id AS sender_id, sender.username AS sender_username,
              m.chat_id, m.provenance_root_message_id, m.content_sha256,
              m.provenance_kind, m.forward_depth, m.media_asset_id,
              media.uploader_id AS media_last_uploader_id,
              media_uploader.username AS media_last_uploader_name
       FROM message_trace_deliveries t
       JOIN messages m ON m.id=t.message_id
       JOIN users recipient ON recipient.id=t.recipient_id
       LEFT JOIN users sender ON sender.id=m.sender_id
       LEFT JOIN media_assets media ON media.id=m.media_asset_id
       LEFT JOIN users media_uploader ON media_uploader.id=media.uploader_id
       WHERE t.trace_code=$1`,
      [code]
    );
    await pool.query(
      `INSERT INTO forensic_access_logs
       (reviewer_id,lookup_type,lookup_value,result_found,requester_ip)
       VALUES ($1,'media_trace',$2,$3,$4)`,
      [req.user.userId, code, Boolean(result.rows[0]), req.ip]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Trace code not found." });
    res.json({ trace: result.rows[0] });
  } catch (err) {
    console.error("[admin media-trace]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// Full chain lookup for authorized forensic reviewers. Unlike normal chat
// APIs, this includes identities, asset hashes and per-recipient trace codes.
router.get("/message-provenance/:messageId", requireForensics, async (req, res) => {
  try {
    const messageId = String(req.params.messageId || "");
    if (!/^[A-Za-z0-9_.:-]{1,50}$/.test(messageId)) {
      return res.status(400).json({ error: "Invalid message id." });
    }
    const result = await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT m.id, m.forwarded_from_message_id, 0 AS hop
         FROM messages m WHERE m.id=$1
         UNION ALL
         SELECT parent.id, parent.forwarded_from_message_id, chain.hop + 1
         FROM chain JOIN messages parent ON parent.id=chain.forwarded_from_message_id
         WHERE chain.hop < 100
       )
       SELECT chain.hop, m.id, m.chat_id, m.created_at, m.provenance_kind,
              m.forward_depth, m.content_sha256, m.media_asset_id,
              sender.id AS sender_id, sender.username AS sender_username,
              media.sha256 AS media_sha256, media.perceptual_hash,
              uploader.id AS media_last_uploader_id,
              uploader.username AS media_last_uploader_name,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'traceCode', t.trace_code,
                  'recipientId', recipient.id,
                  'recipientUsername', recipient.username,
                  'deliveredAt', t.delivered_at
                ) ORDER BY t.delivered_at)
                FROM message_trace_deliveries t
                JOIN users recipient ON recipient.id=t.recipient_id
                WHERE t.message_id=m.id
              ), '[]'::json) AS deliveries
       FROM chain
       JOIN messages m ON m.id=chain.id
       LEFT JOIN users sender ON sender.id=m.sender_id
       LEFT JOIN media_assets media ON media.id=m.media_asset_id
       LEFT JOIN users uploader ON uploader.id=media.uploader_id
       ORDER BY chain.hop ASC`,
      [messageId]
    );
    await pool.query(
      `INSERT INTO forensic_access_logs
       (reviewer_id,lookup_type,lookup_value,result_found,requester_ip)
       VALUES ($1,'message_provenance',$2,$3,$4)`,
      [req.user.userId, messageId, result.rows.length > 0, req.ip]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Message not found." });
    res.json({ chain: result.rows });
  } catch (err) {
    console.error("[admin message-provenance]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/admin/businesses/pending
// Manual review checklist for the reviewer (not automated):
//   1. Confirm GSTIN Portal returned an active GSTIN and review its reference id.
//   2. Compare registered legal name to the entered business name — flag
//      mismatches for follow-up, don't auto-reject (name variations happen).
//   3. Sanity-check registered business category vs. what they're listing.
//   4. Check uploaded address proof / storefront photo against entered
//      city/pincode.
router.get("/businesses/pending", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, name, type, phone, address, city, pincode,
              gst_number, verification_docs, verification_status, created_at,
              gstin_verified, gstin_legal_name, gstin_trade_name,
              gstin_registry_status, gstin_reference_id,
              gstin_registration_date, gstin_name_match, gstin_checked_at,
              gstin_provider
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
// body: { approve: boolean, rejection_reason?: string }
//
// This is the ONLY place verification_status can move to 'verified' or
// 'rejected'. It intentionally has no knowledge of `plan` or payment state —
// do not add any payment/plan check to this route.
router.post("/businesses/:id/verify", async (req, res) => {
  const { approve, rejection_reason } = req.body;

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
           verified = CASE WHEN $1 = 'verified' THEN TRUE ELSE FALSE END,
           verified_at = CASE WHEN $1 = 'verified' THEN NOW() ELSE verified_at END,
           verified_by = $2,
           rejection_reason = CASE WHEN $1 = 'rejected' THEN $3 ELSE NULL END
       WHERE id = $4
         AND verification_status = 'pending'
         AND ($1 <> 'verified' OR (
           gstin_verified = TRUE
           AND LOWER(COALESCE(gstin_registry_status, '')) = 'active'
         ))
       RETURNING id, name, verification_status, verified_at, verified_by, plan`,
      [status, req.user.userId, rejection_reason?.trim() || null, req.params.id]
    );

    if (!result.rows[0]) {
      const existing = await pool.query(
        "SELECT verification_status, gstin_verified, gstin_registry_status FROM businesses WHERE id=$1",
        [req.params.id]
      );
      if (!existing.rows[0]) return res.status(404).json({ error: "Business not found." });
      return res.status(409).json({
        error: approve
          ? "Only a pending business with an active GSTIN Portal-verified GSTIN can be approved."
          : "Only a pending verification can be rejected.",
      });
    }

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

// ─── Report review queue ─────────────────────────────────────────────────
// GET /api/admin/reports?status=open
// Flagged accounts (3+ open reports in 24h, see routes/safety.js) sort to
// the top; everything else is oldest-first so nothing sits unreviewed.
router.get("/reports", async (req, res) => {
  const status = req.query.status || "open";
  try {
    const result = await pool.query(
      `SELECT r.*, 
              u1.username AS reporter_name, u1.phone AS reporter_phone,
              u2.username AS reported_name, u2.phone AS reported_phone,
              u2.flagged_at AS reported_flagged_at
       FROM reports r
       JOIN users u1 ON u1.id = r.reporter_id
       JOIN users u2 ON u2.id = r.reported_id
       WHERE r.status = $1
       ORDER BY (u2.flagged_at IS NOT NULL) DESC, r.created_at ASC`,
      [status]
    );
    res.json({ reports: result.rows });
  } catch (err) {
    console.error("[admin reports]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/admin/reports/:id/resolve
// body: { status: 'reviewed' | 'actioned' | 'dismissed', action_taken?: string }
// This is the ONLY place a report's status changes — always a deliberate
// human decision, logged with reviewer id + timestamp for audit.
router.post("/reports/:id/resolve", async (req, res) => {
  const { status, action_taken } = req.body;
  if (!["reviewed", "actioned", "dismissed"].includes(status)) {
    return res.status(400).json({ error: "status must be reviewed, actioned, or dismissed." });
  }
  try {
    const result = await pool.query(
      `UPDATE reports
       SET status = $1, reviewed_at = NOW(), reviewed_by = $2, action_taken = $3
       WHERE id = $4
       RETURNING id, status, reported_id`,
      [status, req.user.userId, action_taken || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Report not found." });

    console.log(
      `[admin] Report ${req.params.id} marked '${status}' by admin ${req.user.userId} at ${new Date().toISOString()}`
    );
    res.json({ success: true, report: result.rows[0] });
  } catch (err) {
    console.error("[admin reports/resolve]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/admin/reports/flagged-users — quick view of everyone currently
// auto-flagged (3+ open reports in 24h at some point), regardless of
// whether all their individual reports have since been resolved.
router.get("/reports/flagged-users", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, phone, flagged_at,
              (SELECT COUNT(*) FROM reports WHERE reported_id = users.id AND status = 'open') AS open_report_count,
              (SELECT COUNT(*) FROM reports WHERE reported_id = users.id) AS total_report_count
       FROM users
       WHERE flagged_at IS NOT NULL
       ORDER BY flagged_at DESC`
    );
    res.json({ flaggedUsers: result.rows });
  } catch (err) {
    console.error("[admin flagged-users]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/admin/verification-docs/:businessId/:index
// The ONLY way to view a submitted GST certificate / PAN / address proof
// photo — these are stored via uploadPrivateBuffer() (see business.js and
// services/storage.js) specifically so there is no public URL for them at
// all. This route is protected by requireAuth + requireAdmin above.
router.get("/verification-docs/:businessId/:index", async (req, res) => {
  try {
    const biz = await pool.query(
      "SELECT verification_docs FROM businesses WHERE id = $1",
      [req.params.businessId]
    );
    if (!biz.rows[0]) return res.status(404).json({ error: "Business not found." });

    const docs = biz.rows[0].verification_docs || [];
    const doc = docs[parseInt(req.params.index, 10)];
    if (!doc) return res.status(404).json({ error: "Document not found." });

    // Backward compatibility: documents uploaded before this fix were
    // stored with a plain public `url` instead of a private `key`. Those
    // old files are still sitting on the old public path (not retroactively
    // fixed by this patch) — redirect to them as-is rather than erroring.
    if (!doc.key && doc.url) {
      return res.redirect(doc.url);
    }

    const access = await getPrivateFileAccess(doc.key);
    if (!access) return res.status(404).json({ error: "File not found in storage." });

    if (access.type === "redirect") return res.redirect(access.url);
    res.sendFile(access.path);
  } catch (err) {
    console.error("[admin verification-docs]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
