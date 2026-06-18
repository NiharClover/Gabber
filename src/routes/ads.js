const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

// Calculate distance between two coordinates in km
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /api/ads/mine — get ads for my business
router.get("/mine", async (req, res) => {
  try {
    const biz = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (!biz.rows[0]) return res.json({ ads: [] });
    const result = await pool.query(
      "SELECT * FROM ads WHERE business_id = $1 ORDER BY created_at DESC",
      [biz.rows[0].id]
    );
    res.json({ ads: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});
// GET /api/ads/feed?lat=&lng=&city=&pincode=
router.get("/feed", async (req, res) => {
  const { lat, lng, city, pincode } = req.query;
  try {
    // Get all active ads with remaining budget
    const result = await pool.query(
      `SELECT * FROM ads WHERE active = true AND budget_remaining > 0 ORDER BY bid_amount DESC`
    );

    let filtered = result.rows;

    // Filter by location if coordinates provided
    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      filtered = filtered.filter((ad) => {
        // If ad has no location targeting, show everywhere
        if (!ad.target_lat || !ad.target_lng) {
          if (!ad.target_city && !ad.target_pincode) return true;
        }
        // Check pincode match
        if (ad.target_pincode && pincode) {
          return ad.target_pincode === pincode;
        }
        // Check city match
        if (ad.target_city && city) {
          return ad.target_city.toLowerCase() === city.toLowerCase();
        }
        // Check radius
        if (ad.target_lat && ad.target_lng) {
          const dist = haversineDistance(userLat, userLng, ad.target_lat, ad.target_lng);
          return dist <= (ad.target_radius_km || 5);
        }
        return true;
      });
    }

    // Track impressions
    const adIds = filtered.slice(0, 3).map((a) => a.id);
    if (adIds.length > 0) {
      await pool.query(
        "UPDATE ads SET impressions = impressions + 1 WHERE id = ANY($1)",
        [adIds]
      );
    }

    res.json({ ads: filtered.slice(0, 3) });
  } catch (err) {
    console.error("[ads]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/ads/click/:id
router.post("/click/:id", async (req, res) => {
  try {
    await pool.query(
      `UPDATE ads SET clicks = clicks + 1, budget_remaining = budget_remaining - bid_amount WHERE id = $1`,
      [req.params.id]
    );
    await pool.query(
      `INSERT INTO ad_clicks (ad_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/ads — create ad (business only)
router.post("/", async (req, res) => {
  const { title, description, imageUrl, ctaText, ctaUrl, adType, targetCity, targetPincode, targetLat, targetLng, targetRadiusKm, bidAmount, budgetTotal } = req.body;
  if (!title) return res.status(400).json({ error: "title required." });
  try {
    const biz = await pool.query("SELECT id FROM businesses WHERE user_id = $1", [req.user.userId]);
    if (!biz.rows[0]) return res.status(403).json({ error: "Business account required." });
    const id = `ad_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO ads (id, business_id, title, description, image_url, cta_text, cta_url, ad_type,
        target_city, target_pincode, target_lat, target_lng, target_radius_km, bid_amount, budget_total, budget_remaining)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
      [id, biz.rows[0].id, title, description, imageUrl, ctaText || "Learn More", ctaUrl, adType || "card",
       targetCity, targetPincode, targetLat, targetLng, targetRadiusKm || 5, bidAmount || 1.00, budgetTotal || 1000.00]
    );
    res.json({ success: true, ad: result.rows[0] });
  } catch (err) {
    console.error("[ads]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;