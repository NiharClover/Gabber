const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const { isValidGSTIN } = require("../utils/gstin");
const { uploadBuffer, uploadPrivateBuffer } = require("../services/storage");
const { normalizeBusinessDetails, normalizeMenuItem } = require("../utils/businessValidation");
const { verifyGstin } = require("../services/cashfreeGstin");
const { ORDER_FULFILLMENT_MODES, BOOKING_FULFILLMENT_MODES, parseFulfillmentModes } = require("../utils/fulfillment");
const { rateLimit } = require("express-rate-limit");

const router = express.Router();
router.use(requireAuth);

// Never return raw business rows from customer-facing endpoints. In
// particular, verification_docs contains private storage keys and
// verified_by/rejection_reason are review metadata.
const PUBLIC_BUSINESS_FIELDS = `
  id, user_id, name, type, phone, address, city, pincode, lat, lng,
  verification_status, fulfillment_modes, created_at
`;
const OWNER_BUSINESS_FIELDS = `
  id, user_id, name, type, phone, address, city, pincode, lat, lng,
  gst_number, verification_status, gstin_verified, gstin_legal_name,
  gstin_trade_name, gstin_registry_status, gstin_reference_id,
  gstin_registration_date, gstin_name_match, gstin_checked_at, gstin_provider,
  verified_at, rejection_reason, plan, fulfillment_modes, created_at
`;

function withCapabilities(business, isOwner = false) {
  if (!business) return null;
  const verified = business.verification_status === "verified";
  const fulfillmentModes = parseFulfillmentModes(business.fulfillment_modes, business.type);
  return {
    ...business,
    fulfillment_modes: fulfillmentModes,
    capabilities: {
      isPublic: verified,
      canAcceptOrders: verified && fulfillmentModes.some((mode) => ORDER_FULFILLMENT_MODES.has(mode)),
      canAcceptBookings: verified && fulfillmentModes.some((mode) => BOOKING_FULFILLMENT_MODES.has(mode)),
      canRunAds: verified,
      canManageCatalogue: isOwner,
      canRequestVerification: isOwner && ["unverified", "rejected"].includes(business.verification_status),
    },
  };
}

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

const menuImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, or WEBP images are allowed."));
  },
});

const gstinVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user.userId,
  message: { error: "Too many GSTIN verification attempts. Try again later." },
});

// POST /api/business/register
router.post("/register", async (req, res) => {
  const normalized = normalizeBusinessDetails(req.body);
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  const { name, type, phone, address, city, pincode, lat, lng, gstNumber, fulfillmentModes } = normalized.value;
  if (gstNumber && !isValidGSTIN(gstNumber)) return res.status(400).json({ error: "Invalid GSTIN." });
  try {
    // Check if user already has a business
    const existing = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "You already have a registered business." });
    }
    const id = `biz_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO businesses (id, user_id, name, type, phone, address, city, pincode, lat, lng, gst_number, fulfillment_modes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${OWNER_BUSINESS_FIELDS}`,
      [id, req.user.userId, name, type || "general", phone, address, city, pincode, lat, lng, gstNumber, JSON.stringify(fulfillmentModes)]
    );
    res.status(201).json({ success: true, business: withCapabilities(result.rows[0], true) });
  } catch (err) {
    console.error("[business]", err.message);
    if (err.code === "23505") return res.status(409).json({ error: "You already have a registered business." });
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/mine
router.get("/mine", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${OWNER_BUSINESS_FIELDS} FROM businesses WHERE user_id = $1`,
      [req.user.userId]
    );
    res.json({ business: withCapabilities(result.rows[0], true) });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// PATCH /api/business/:id - update an owned business. Identity/location
// changes invalidate an existing review so verification remains meaningful.
router.patch("/:id", async (req, res) => {
  try {
    const currentResult = await pool.query(
      `SELECT ${OWNER_BUSINESS_FIELDS} FROM businesses WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.userId]
    );
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ error: "Business not found." });

    const normalized = normalizeBusinessDetails({
      name: req.body.name ?? current.name,
      type: req.body.type ?? current.type,
      phone: req.body.phone ?? current.phone,
      address: req.body.address ?? current.address,
      city: req.body.city ?? current.city,
      pincode: req.body.pincode ?? current.pincode,
      lat: req.body.lat ?? current.lat,
      lng: req.body.lng ?? current.lng,
      gstNumber: req.body.gstNumber ?? current.gst_number,
      fulfillmentModes: req.body.fulfillmentModes ?? current.fulfillment_modes,
    });
    if (!normalized.ok) return res.status(400).json({ error: normalized.error });
    const value = normalized.value;
    if (value.gstNumber && !isValidGSTIN(value.gstNumber)) return res.status(400).json({ error: "Invalid GSTIN." });

    const identityChanged = ["name", "type", "phone", "address", "city", "pincode", "lat", "lng"]
      .some((field) => String(value[field] ?? "") !== String(current[field] ?? ""))
      || String(value.gstNumber ?? "") !== String(current.gst_number ?? "");
    const resetVerification = identityChanged && current.verification_status !== "unverified";

    const result = await pool.query(
      `UPDATE businesses
       SET name=$1, type=$2, phone=$3, address=$4, city=$5, pincode=$6,
           lat=$7, lng=$8, gst_number=$9, fulfillment_modes=$10,
           verification_status=CASE WHEN $11 THEN 'unverified' ELSE verification_status END,
           verification_docs=CASE WHEN $11 THEN '[]'::jsonb ELSE verification_docs END,
           gstin_verified=CASE WHEN $11 THEN FALSE ELSE gstin_verified END,
           gstin_legal_name=CASE WHEN $11 THEN NULL ELSE gstin_legal_name END,
           gstin_trade_name=CASE WHEN $11 THEN NULL ELSE gstin_trade_name END,
           gstin_registry_status=CASE WHEN $11 THEN NULL ELSE gstin_registry_status END,
           gstin_reference_id=CASE WHEN $11 THEN NULL ELSE gstin_reference_id END,
           gstin_registration_date=CASE WHEN $11 THEN NULL ELSE gstin_registration_date END,
           gstin_name_match=CASE WHEN $11 THEN NULL ELSE gstin_name_match END,
           gstin_checked_at=CASE WHEN $11 THEN NULL ELSE gstin_checked_at END,
           gstin_provider=CASE WHEN $11 THEN NULL ELSE gstin_provider END,
           verified_at=CASE WHEN $11 THEN NULL ELSE verified_at END,
           verified_by=CASE WHEN $11 THEN NULL ELSE verified_by END,
           rejection_reason=CASE WHEN $11 THEN NULL ELSE rejection_reason END
       WHERE id=$12 AND user_id=$13
       RETURNING ${OWNER_BUSINESS_FIELDS}`,
      [value.name, value.type, value.phone, value.address, value.city, value.pincode,
        value.lat, value.lng, value.gstNumber, JSON.stringify(value.fulfillmentModes), resetVerification, req.params.id, req.user.userId]
    );
    res.json({
      success: true,
      reverificationRequired: resetVerification,
      business: withCapabilities(result.rows[0], true),
    });
  } catch (err) {
    console.error("[business update]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/:id
router.get("/:id", async (req, res) => {
  try {
    const biz = await pool.query(
      `SELECT ${PUBLIC_BUSINESS_FIELDS} FROM businesses WHERE id = $1`,
      [req.params.id]
    );
    if (!biz.rows[0]) return res.status(404).json({ error: "Not found." });
    const isOwner = biz.rows[0].user_id === req.user.userId;
    if (!isOwner && biz.rows[0].verification_status !== "verified") {
      return res.status(404).json({ error: "Business not found." });
    }
    const menu = await pool.query(
      `SELECT id, business_id, name, description, price, category, available, image_url, created_at, updated_at
       FROM menu_items WHERE business_id = $1 AND ($2::boolean OR available = TRUE)
       ORDER BY category, name`,
      [req.params.id, isOwner]
    );
    res.json({ business: withCapabilities(biz.rows[0], isOwner), menu: menu.rows });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/business/menu
router.post("/menu", async (req, res) => {
  const normalized = normalizeMenuItem(req.body);
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  const { name, description, price, category, available } = normalized.value;
  try {
    const biz = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (!biz.rows[0]) return res.status(404).json({ error: "No business found." });
    const id = `item_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO menu_items (id, business_id, name, description, price, category, available)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, biz.rows[0].id, name, description, price, category, available]
    );
    res.status(201).json({ success: true, item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/business/menu/mine - includes unavailable items for management.
router.get("/menu/mine", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mi.id, mi.business_id, mi.name, mi.description, mi.price, mi.category,
              mi.available, mi.image_url, mi.created_at, mi.updated_at
       FROM menu_items mi JOIN businesses b ON b.id=mi.business_id
       WHERE b.user_id=$1 ORDER BY mi.category, mi.name`,
      [req.user.userId]
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error("[business menu mine]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

router.patch("/menu/:id", async (req, res) => {
  try {
    const currentResult = await pool.query(
      `SELECT mi.* FROM menu_items mi JOIN businesses b ON b.id=mi.business_id
       WHERE mi.id=$1 AND b.user_id=$2`,
      [req.params.id, req.user.userId]
    );
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ error: "Menu item not found." });
    const normalized = normalizeMenuItem({
      name: req.body.name ?? current.name,
      description: req.body.description ?? current.description,
      price: req.body.price ?? current.price,
      category: req.body.category ?? current.category,
      available: req.body.available ?? current.available,
    });
    if (!normalized.ok) return res.status(400).json({ error: normalized.error });
    const value = normalized.value;
    const result = await pool.query(
      `UPDATE menu_items SET name=$1, description=$2, price=$3, category=$4,
              available=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [value.name, value.description, value.price, value.category, value.available, req.params.id]
    );
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error("[business menu update]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

router.post("/menu/:id/image", menuImageUpload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Image required." });
  try {
    const owned = await pool.query(
      `SELECT mi.id FROM menu_items mi JOIN businesses b ON b.id=mi.business_id
       WHERE mi.id=$1 AND b.user_id=$2`,
      [req.params.id, req.user.userId]
    );
    if (!owned.rows[0]) return res.status(404).json({ error: "Menu item not found." });
    let image;
    try {
      image = await sharp(req.file.buffer)
        .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      return res.status(400).json({ error: "That does not look like a valid image." });
    }
    const filename = `menu_${req.params.id}_${randomUUID()}.jpg`;
    const imageUrl = await uploadBuffer(image, "menu", filename, "image/jpeg", req);
    const result = await pool.query(
      "UPDATE menu_items SET image_url=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [imageUrl, req.params.id]
    );
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error("[business menu image]", err.message);
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
    const result = await pool.query(
      `SELECT ${PUBLIC_BUSINESS_FIELDS} FROM businesses
       WHERE user_id = $1 AND (verification_status='verified' OR user_id=$2)`,
      [req.params.userId, req.user.userId]
    );
    res.json({ business: withCapabilities(result.rows[0], result.rows[0]?.user_id === req.user.userId) });
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
  gstinVerificationLimiter,
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
    if (!["gst_certificate", "address_proof", "pan"].some((field) => req.files?.[field]?.[0])) {
      return res.status(400).json({ error: "At least one supporting document is required." });
    }

    try {
      const biz = await pool.query(
        "SELECT id, user_id, name, verification_status FROM businesses WHERE id = $1",
        [req.params.id]
      );
      if (!biz.rows[0]) return res.status(404).json({ error: "Business not found." });
      if (biz.rows[0].user_id !== req.user.userId) {
        return res.status(403).json({ error: "Not your business." });
      }
      if (biz.rows[0].verification_status === "verified") {
        return res.status(400).json({ error: "This business is already verified." });
      }
      if (biz.rows[0].verification_status === "pending") {
        return res.status(409).json({ error: "This business already has a verification under review." });
      }

      let gstinCheck;
      try {
        gstinCheck = await verifyGstin({
          gstin: gstin.trim().toUpperCase(),
          businessName: biz.rows[0].name,
        });
      } catch (verificationError) {
        return res.status(verificationError.status || 503).json({
          error: verificationError.message,
          code: verificationError.code || "GSTIN_SERVICE_UNAVAILABLE",
        });
      }
      if (!gstinCheck.valid) {
        return res.status(400).json({ error: "This GSTIN was not found in the GST registry." });
      }
      if (!gstinCheck.active) {
        return res.status(400).json({ error: `This GSTIN is ${gstinCheck.registryStatus || "not active"} and cannot be verified.` });
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
             gstin_verified = TRUE,
             gstin_legal_name = $3,
             gstin_trade_name = $4,
             gstin_registry_status = $5,
             gstin_reference_id = $6,
             gstin_registration_date = $7,
             gstin_name_match = $8,
             gstin_checked_at = NOW(),
             gstin_provider = 'cashfree',
             rejection_reason = NULL
         WHERE id = $9 AND verification_status IN ('unverified','rejected')
         RETURNING id, verification_status, gstin_verified, gstin_legal_name,
                   gstin_trade_name, gstin_registry_status, gstin_name_match`,
        [
          gstin.toUpperCase(), JSON.stringify(docs), gstinCheck.legalName,
          gstinCheck.tradeName, gstinCheck.registryStatus, gstinCheck.referenceId,
          gstinCheck.registrationDate, gstinCheck.nameMatch, req.params.id,
        ]
      );

      if (!result.rows[0]) {
        return res.status(409).json({ error: "Verification state changed. Refresh and try again." });
      }

      res.json({ success: true, business: result.rows[0] });
    } catch (err) {
      console.error("[business verify-request]", err.message);
      res.status(500).json({ error: "Server error." });
    }
  }
);

module.exports = router;
