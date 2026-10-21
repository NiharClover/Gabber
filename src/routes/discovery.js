const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = req.query.radiusKm == null ? 10 : Number(req.query.radiusKm);
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 50);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "Valid latitude and longitude are required." });
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 100) {
    return res.status(400).json({ error: "Radius must be between 1 and 100 km." });
  }

  // The bounding box is index-friendly; Haversine then removes corner false
  // positives and provides an accurate display/sort distance.
  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / Math.max(111.32 * Math.cos(lat * Math.PI / 180), 0.01);
  try {
    const result = await pool.query(
      `WITH candidates AS (
         SELECT b.id, b.user_id, b.name, b.type, b.phone, b.address, b.city,
                b.pincode, b.lat, b.lng, b.verification_status, b.fulfillment_modes, b.created_at,
                6371 * 2 * asin(sqrt(LEAST(1, GREATEST(0,
                  power(sin(radians(b.lat::double precision - $1) / 2), 2) +
                  cos(radians($1)) * cos(radians(b.lat::double precision)) *
                  power(sin(radians(b.lng::double precision - $2) / 2), 2)
                )))) AS distance_km
         FROM businesses b
         WHERE b.verification_status='verified'
           AND b.lat BETWEEN $1-$4 AND $1+$4
           AND b.lng BETWEEN $2-$5 AND $2+$5
           AND ($6='' OR b.type=$6)
           AND ($7='' OR b.name ILIKE '%' || $7 || '%' OR b.city ILIKE '%' || $7 || '%'
                OR EXISTS (SELECT 1 FROM menu_items mi WHERE mi.business_id=b.id AND mi.available=TRUE
                           AND (mi.name ILIKE '%' || $7 || '%' OR mi.category ILIKE '%' || $7 || '%')))
       )
       SELECT c.*,
              (SELECT COUNT(*)::int FROM menu_items mi WHERE mi.business_id=c.id AND mi.available=TRUE) AS catalogue_count
       FROM candidates c WHERE c.distance_km <= $3
       ORDER BY c.distance_km, c.name LIMIT $8 OFFSET $9`,
      [lat, lng, radiusKm, latDelta, lngDelta, category, query, limit, offset]
    );
    res.json({
      businesses: result.rows.map((row) => ({
        id: row.id, userId: row.user_id, name: row.name, type: row.type,
        phone: row.phone, address: row.address, city: row.city, pincode: row.pincode,
        lat: Number(row.lat), lng: Number(row.lng), distanceKm: Number(Number(row.distance_km).toFixed(2)),
        catalogueCount: row.catalogue_count, verificationStatus: row.verification_status,
        fulfillmentModes: row.fulfillment_modes,
      })),
      query: { lat, lng, radiusKm, category: category || null, q: query || null, limit, offset },
    });
  } catch (err) {
    console.error("[discovery]", err.message);
    res.status(500).json({ error: "Could not load nearby businesses." });
  }
});

module.exports = router;
