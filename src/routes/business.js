const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const { isValidGSTIN } = require("../utils/gstin");
const { uploadPrivateBuffer } = require("../services/storage");

const router = express.Router();
router.use(requireAuth);

// SECURITY FIX: verification documents are government-ID-adjacent material
// (GST certificates, PAN cards, address proof). This used to write them
// straight into the PUBLIC ../uploads/verification folder and store a
// plain, world-readable URL — anyone who obtained that URL (browser
// history, server logs, a referrer header, a screenshot) could view
// someone's PAN card with zero authentication. Now stored via
// uploadPrivateBuffer(), outside the public web root, resolved only
// through the admin-authenticated route in routes/admin.js.
const verifyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, or WEBP images are allowed."));
  },
});

// POST /api/business/register
router.post("/register", async (req, res) => {
  const { name, type, phone, address, city, pincode, lat, lng, gstNumber } = req.body;
  if (!name) return res.status(400).json({ error: "Business name required." });
  try {
    // Check if user already has a business
    const existing = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "You already have a registered business." });
    }
    const id = `biz_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO businesses (id, user_id, name, type, phone, address, city, pincode, lat, lng, gst_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, req.user.userId, name, type || "general", phone, address, city, pincode, lat, lng, gstNumber]
    );
    res.json({ success: true, business: result.rows[0] });
  } catch (err) {
    console.error("[business]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/mine
router.get("/mine", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM businesses WHERE user_id = $1", [req.user.userId]);
    res.json({ business: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/:id
router.get("/:id", async (req, res) => {
  try {
    const biz = await pool.query("SELECT * FROM businesses WHERE id = $1", [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: "Not found." });
    const menu = await pool.query(
      "SELECT * FROM menu_items WHERE business_id = $1 AND available = true ORDER BY category, name",
      [req.params.id]
    );
    res.json({ business: biz.rows[0], menu: menu.rows });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/business/menu
router.post("/menu", async (req, res) => {
  const { name, description, price, category } = req.body;
  if (!name || !price) return res.status(400).json({ error: "name and price required." });
  try {
    const biz = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (!biz.rows[0]) return res.status(404).json({ error: "No business found." });
    const id = `item_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO menu_items (id, business_id, name, description, price, category)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, biz.rows[0].id, name, description, price, category || "General"]
    );
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/business/menu/:id
// Previously deleted ANY menu item by id with no check that the caller
// owns the business it belongs to — any authenticated user could delete
// a competitor's entire menu by enumerating item ids.
router.delete("/menu/:id", async (req, res) => {
  try {
    const item = await pool.query(
      `SELECT mi.id, b.user_id AS business_owner_id
       FROM menu_items mi
       JOIN businesses b ON b.id = mi.business_id
       WHERE mi.id = $1`,
      [req.params.id]
    );
    if (!item.rows[0]) return res.status(404).json({ error: "Menu item not found." });
    if (item.rows[0].business_owner_id !== req.user.userId) {
      return res.status(403).json({ error: "Not your business." });
    }

    await pool.query("DELETE FROM menu_items WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("[business menu delete]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/by-user/:userId
router.get("/by-user/:userId", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM businesses WHERE user_id = $1", [req.params.userId]);
    res.json({ business: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});


// ─── Business Verification (identity check — NEVER gated by payment) ─────
// POST /api/business/:id/verify-request
// Accepts a GSTIN + supporting documents and puts the business into the
// manual review queue (routes/admin.js). This route intentionally never
// reads or writes `plan`, and never checks any payment/subscription state.
// Verification and monetization are two independent systems by design —
// see the acceptance criteria in the verification system spec.
router.post(
  "/:id/verify-request",
  verifyUpload.fields([
    { name: "gst_certificate", maxCount: 1 },
    { name: "address_proof", maxCount: 1 },
    { name: "pan", maxCount: 1 },
  ]),
  async (req, res) => {
    const { gstin } = req.body;

    // Free, instant, zero-cost check — catches obviously fake/mistyped
    // GSTINs before anything reaches a human reviewer or (later) a paid
    // KYC API call.
    if (!gstin || !isValidGSTIN(gstin)) {
      return res.status(400).json({ error: "Invalid GSTIN format or checksum. Double-check and try again." });
    }

    try {
      const biz = await pool.query(
        "SELECT id, user_id, verification_status FROM businesses WHERE id = $1",
        [req.params.id]
      );
      if (!biz.rows[0]) return res.status(404).json({ error: "Business not found." });
      if (biz.rows[0].user_id !== req.user.userId) {
        return res.status(403).json({ error: "Not your business." });
      }
      if (biz.rows[0].verification_status === "verified") {
        return res.status(400).json({ error: "This business is already verified." });
      }

      const docs = [];
      for (const field of ["gst_certificate", "address_proof", "pan"]) {
        const file = req.files?.[field]?.[0];
        if (!file) continue;

        let compressed;
        try {
          compressed = await sharp(file.buffer)
            .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } catch (imgErr) {
          // sharp throws on anything it can't decode as an image — this is
          // also what actually stops a disguised non-image file from
          // getting through, on top of the mimetype fileFilter above.
          return res.status(400).json({ error: `${field.replace("_", " ")} doesn't look like a valid image file.` });
        }

        const filename = `${field}_${Date.now()}_${randomUUID().split("-")[0]}.jpg`;
        const key = await uploadPrivateBuffer(compressed, "verification", filename, "image/jpeg");
        docs.push({
          type: field,
          key, // opaque storage key — resolved only via the admin-authenticated route, never a public URL
          uploaded_at: new Date().toISOString(),
        });
      }

      if (docs.length === 0) {
        return res.status(400).json({ error: "At least one supporting document is required." });
      }

      const result = await pool.query(
        `UPDATE businesses
         SET gst_number = $1,
             verification_status = 'pending',
             verification_docs = $2,
             rejection_reason = NULL
         WHERE id = $3
         RETURNING id, verification_status`,
        [gstin.toUpperCase(), JSON.stringify(docs), req.params.id]
      );

      res.json({ success: true, business: result.rows[0] });
    } catch (err) {
      console.error("[business verify-request]", err.message);
      res.status(500).json({ error: "Server error." });
    }
  }
);

module.exports = router;