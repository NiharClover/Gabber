const express = require("express");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { isAdEligible } = require("../utils/adTargeting");
const { PLACEMENT_TO_TYPE, normalizeAd, toAdDto } = require("../utils/adLifecycle");

const router = express.Router();
router.use(requireAuth);
const AD_SELECT = `SELECT a.*,b.name AS business_name,b.user_id AS business_owner_id
  FROM ads a JOIN businesses b ON b.id=a.business_id`;

router.get("/mine", async (req, res) => {
  try {
    const result = await pool.query(`${AD_SELECT} WHERE b.user_id=$1 ORDER BY a.created_at DESC`, [req.user.userId]);
    res.json({ ads: result.rows.map(toAdDto) });
  } catch (err) { console.error("[ads mine]", err.message); res.status(500).json({ error: "Server error." }); }
});

router.get("/feed", async (req, res) => {
  const placement = typeof req.query.placement === "string" ? req.query.placement : "chat_list";
  const adType = PLACEMENT_TO_TYPE[placement];
  if (!adType) return res.status(400).json({ error: "Unknown promotion placement." });
  const userLat = Number(req.query.lat); const userLng = Number(req.query.lng);
  const context = {
    lat: userLat, lng: userLng,
    hasCoordinates: Number.isFinite(userLat) && Number.isFinite(userLng) && userLat >= -90 && userLat <= 90 && userLng >= -180 && userLng <= 180,
    city: typeof req.query.city === "string" ? req.query.city.trim().toLowerCase() : "",
    pincode: typeof req.query.pincode === "string" ? req.query.pincode.trim() : "",
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `${AD_SELECT} WHERE a.active=TRUE AND a.budget_remaining >= a.bid_amount
       AND a.ad_type=$1 AND b.verification_status='verified' ORDER BY a.bid_amount DESC,a.created_at DESC LIMIT 100`, [adType]
    );
    const rows = result.rows.filter((ad) => isAdEligible(ad, context)).slice(0, 3);
    for (const ad of rows) {
      await client.query("UPDATE ads SET impressions=impressions+1 WHERE id=$1", [ad.id]);
      await client.query(
        `INSERT INTO ad_events (id,ad_id,user_id,event_type,placement,metadata)
         VALUES ($1,$2,$3,'impression',$4,$5)`,
        [`adevt_${randomUUID()}`, ad.id, req.user.userId, placement, JSON.stringify({ city: context.city || null, pincode: context.pincode || null })]
      );
      ad.impressions = Number(ad.impressions || 0) + 1;
    }
    await client.query("COMMIT");
    res.json({ ads: rows.map(toAdDto), placement });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {}); console.error("[ads feed]", err.message);
    res.status(500).json({ error: "Server error." });
  } finally { client.release(); }
});

router.post("/click/:id", async (req, res) => {
  const placement = typeof req.body.placement === "string" ? req.body.placement : "chat_list";
  const expectedType = PLACEMENT_TO_TYPE[placement];
  if (!expectedType) return res.status(400).json({ error: "Unknown promotion placement." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const adResult = await client.query(`${AD_SELECT} WHERE a.id=$1 AND a.ad_type=$2 FOR UPDATE OF a`, [req.params.id, expectedType]);
    const ad = adResult.rows[0];
    if (!ad || !ad.active || Number(ad.budget_remaining) < Number(ad.bid_amount)) throw Object.assign(new Error("Promotion is unavailable."), { status: 409 });
    const click = await client.query(`INSERT INTO ad_clicks (ad_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING ad_id`, [ad.id, req.user.userId]);
    let counted = false;
    if (click.rows[0]) {
      counted = true;
      const updated = await client.query(`UPDATE ads SET clicks=clicks+1,budget_remaining=budget_remaining-bid_amount WHERE id=$1 RETURNING clicks,budget_remaining`, [ad.id]);
      ad.clicks = updated.rows[0].clicks; ad.budget_remaining = updated.rows[0].budget_remaining;
    }
    await client.query(
      `INSERT INTO ad_events (id,ad_id,user_id,event_type,placement,metadata) VALUES ($1,$2,$3,'click',$4,$5)`,
      [`adevt_${randomUUID()}`, ad.id, req.user.userId, placement, JSON.stringify({ counted, destination: ad.cta_url || `business:${ad.business_id}` })]
    );
    await client.query("COMMIT");
    res.json({ success: true, counted, ad: toAdDto(ad), destination: ad.cta_url || null });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {}); res.status(err.status || 500).json({ error: err.status ? err.message : "Server error." });
  } finally { client.release(); }
});

router.patch("/:id/status", async (req, res) => {
  if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "active must be true or false." });
  try {
    const result = await pool.query(
      `UPDATE ads a SET active=$1 FROM businesses b WHERE a.id=$2 AND a.business_id=b.id AND b.user_id=$3
       RETURNING a.*,(SELECT name FROM businesses WHERE id=a.business_id) AS business_name,$3::varchar AS business_owner_id`,
      [req.body.active, req.params.id, req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Promotion not found." });
    res.json({ ad: toAdDto(result.rows[0]) });
  } catch (err) { console.error("[ad status]", err.message); res.status(500).json({ error: "Server error." }); }
});

router.post("/", async (req, res) => {
  const normalized = normalizeAd(req.body);
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  const value = normalized.value;
  try {
    const biz = await pool.query("SELECT id,name,user_id,verification_status FROM businesses WHERE user_id=$1", [req.user.userId]);
    if (!biz.rows[0]) return res.status(403).json({ error: "Business account required." });
    if (biz.rows[0].verification_status !== "verified") return res.status(403).json({ error: "Business verification is required before running promotions." });
    const id = `ad_${randomUUID().split("-")[0]}`;
    const result = await pool.query(
      `INSERT INTO ads (id,business_id,title,description,image_url,cta_text,cta_url,ad_type,target_city,target_pincode,target_lat,target_lng,target_radius_km,bid_amount,budget_total,budget_remaining)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
      [id,biz.rows[0].id,value.title,value.description,null,value.ctaText,value.ctaUrl,value.adType,value.targetCity,value.targetPincode,value.targetLat,value.targetLng,value.targetRadiusKm,value.bidAmount,value.budgetTotal]
    );
    res.status(201).json({ success: true, ad: toAdDto({ ...result.rows[0], business_name: biz.rows[0].name, business_owner_id: biz.rows[0].user_id }) });
  } catch (err) { console.error("[ad create]", err.message); res.status(500).json({ error: "Server error." }); }
});

module.exports = router;
