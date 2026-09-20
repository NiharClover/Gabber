const BUSINESS_TYPES = new Set(["restaurant", "hotel", "food_stall", "shop", "service", "general"]);

function cleanString(value, maxLength) {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function normalizeBusinessDetails(input = {}) {
  const name = cleanString(input.name, 100);
  const type = cleanString(input.type, 50) || "general";
  const phone = cleanString(input.phone, 20);
  const address = cleanString(input.address, 500);
  const city = cleanString(input.city, 50);
  const pincode = cleanString(input.pincode, 10);
  const gstNumber = cleanString(input.gstNumber ?? input.gst_number, 20)?.toUpperCase() || null;

  if (!name || name.length < 2) return { ok: false, error: "Business name must be at least 2 characters." };
  if (!BUSINESS_TYPES.has(type)) return { ok: false, error: "Invalid business type." };
  if (phone && !/^\+[1-9]\d{9,14}$/.test(phone)) {
    return { ok: false, error: "Business phone must use international format, for example +919876543210." };
  }
  if (pincode && !/^\d{6}$/.test(pincode)) return { ok: false, error: "Pincode must contain 6 digits." };

  const hasLat = input.lat !== null && input.lat !== undefined && input.lat !== "";
  const hasLng = input.lng !== null && input.lng !== undefined && input.lng !== "";
  if (hasLat !== hasLng) return { ok: false, error: "Latitude and longitude must be provided together." };
  const lat = hasLat ? Number(input.lat) : null;
  const lng = hasLng ? Number(input.lng) : null;
  if (hasLat && (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180)) {
    return { ok: false, error: "Invalid business coordinates." };
  }

  return { ok: true, value: { name, type, phone, address, city, pincode, lat, lng, gstNumber } };
}

function normalizeMenuItem(input = {}) {
  const name = cleanString(input.name, 100);
  const description = cleanString(input.description, 2000);
  const category = cleanString(input.category, 50) || "General";
  const price = Number(input.price);
  const available = input.available === undefined ? true : input.available;

  if (!name) return { ok: false, error: "Item name is required." };
  const fractionalCents = Math.abs(price * 100 - Math.round(price * 100));
  if (!Number.isFinite(price) || price <= 0 || price > 10000000 || fractionalCents > 1e-8) {
    return { ok: false, error: "Price must be a positive amount with at most two decimal places." };
  }
  if (typeof available !== "boolean") return { ok: false, error: "available must be true or false." };
  return { ok: true, value: { name, description, category, price: price.toFixed(2), available } };
}

module.exports = { BUSINESS_TYPES, normalizeBusinessDetails, normalizeMenuItem };
