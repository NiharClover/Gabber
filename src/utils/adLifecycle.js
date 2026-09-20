const AD_TYPES = new Set(["card", "explore"]);
const PLACEMENT_TO_TYPE = Object.freeze({ chat_list: "card", explore: "explore" });

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeAd(input = {}) {
  const title = clean(input.title, 100);
  const description = clean(input.description, 500);
  const ctaText = clean(input.ctaText, 30) || "View business";
  const ctaUrl = clean(input.ctaUrl, 1000) || null;
  const adType = clean(input.adType, 20) || "card";
  const targetCity = clean(input.targetCity, 50) || null;
  const targetPincode = clean(input.targetPincode, 10) || null;
  const hasLat = input.targetLat !== null && input.targetLat !== undefined && input.targetLat !== "";
  const hasLng = input.targetLng !== null && input.targetLng !== undefined && input.targetLng !== "";
  const targetLat = hasLat ? Number(input.targetLat) : null;
  const targetLng = hasLng ? Number(input.targetLng) : null;
  const targetRadiusKm = Number(input.targetRadiusKm ?? 5);
  const bidAmount = Number(input.bidAmount ?? 1);
  const budgetTotal = Number(input.budgetTotal ?? 1000);
  if (title.length < 2) return { ok: false, error: "Title must be at least 2 characters." };
  if (description.length < 2) return { ok: false, error: "Description must be at least 2 characters." };
  if (!AD_TYPES.has(adType)) return { ok: false, error: "Unsupported promotion placement." };
  if (ctaUrl && !/^https?:\/\//i.test(ctaUrl)) return { ok: false, error: "CTA URL must start with http:// or https://." };
  if (targetPincode && !/^\d{6}$/.test(targetPincode)) return { ok: false, error: "Target pincode must contain 6 digits." };
  if (hasLat !== hasLng || (hasLat && (!Number.isFinite(targetLat) || targetLat < -90 || targetLat > 90 || !Number.isFinite(targetLng) || targetLng < -180 || targetLng > 180))) return { ok: false, error: "Valid target latitude and longitude must be provided together." };
  if (!Number.isFinite(targetRadiusKm) || targetRadiusKm < 1 || targetRadiusKm > 100) return { ok: false, error: "Target radius must be between 1 and 100 km." };
  if (!Number.isFinite(bidAmount) || bidAmount <= 0 || bidAmount > 10000) return { ok: false, error: "Bid amount is invalid." };
  if (!Number.isFinite(budgetTotal) || budgetTotal < 100 || budgetTotal > 10000000 || bidAmount > budgetTotal) return { ok: false, error: "Budget must be between ₹100 and ₹1,00,00,000 and at least the bid." };
  return { ok: true, value: { title, description, ctaText, ctaUrl, adType, targetCity, targetPincode, targetLat, targetLng, targetRadiusKm, bidAmount, budgetTotal } };
}

function toAdDto(row) {
  return {
    id: row.id, title: row.title, description: row.description || null, imageUrl: row.image_url || null,
    cta: { text: row.cta_text || "View business", url: row.cta_url || null },
    placement: row.ad_type === "explore" ? "explore" : "chat_list",
    targeting: { city: row.target_city || null, pincode: row.target_pincode || null, lat: row.target_lat == null ? null : Number(row.target_lat), lng: row.target_lng == null ? null : Number(row.target_lng), radiusKm: Number(row.target_radius_km || 5) },
    budget: { total: Number(row.budget_total), remaining: Number(row.budget_remaining), bidPerClick: Number(row.bid_amount) },
    analytics: { impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0) },
    active: Boolean(row.active), createdAt: row.created_at,
    business: { id: row.business_id, name: row.business_name || null, ownerId: row.business_owner_id || null },
  };
}

module.exports = { AD_TYPES, PLACEMENT_TO_TYPE, normalizeAd, toAdDto };
