const FULFILLMENT_MODES = Object.freeze({
  pickup: "Store pickup",
  in_store: "Buy or collect in store",
  appointment: "Appointment at business",
  on_site_service: "Service at customer location",
  merchant_delivery: "Business delivery",
  customer_courier: "Customer-arranged courier",
  chat_only: "Chat and enquiries only",
});

const ORDER_FULFILLMENT_MODES = new Set(["pickup", "in_store", "merchant_delivery", "customer_courier"]);
const BOOKING_FULFILLMENT_MODES = new Set(["appointment", "on_site_service"]);
const CUSTOMER_COLLECTION_MODES = new Set(["pickup", "in_store", "customer_courier"]);

function defaultFulfillmentModes(type) {
  if (type === "hotel") return ["appointment", "chat_only"];
  if (type === "service") return ["appointment", "on_site_service", "chat_only"];
  if (type === "restaurant" || type === "food_stall") return ["pickup", "in_store", "chat_only"];
  return ["pickup", "in_store", "chat_only"];
}

function parseFulfillmentModes(value, type = "general") {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { candidate = []; }
  }
  if (!Array.isArray(candidate) || candidate.length === 0) return defaultFulfillmentModes(type);
  return [...new Set(candidate.filter((mode) => Object.hasOwn(FULFILLMENT_MODES, mode)))];
}

function normalizeFulfillmentModes(value, type) {
  if (value === undefined || value === null) return { ok: true, modes: defaultFulfillmentModes(type) };
  if (!Array.isArray(value)) return { ok: false, error: "fulfillmentModes must be a list." };
  const invalid = value.find((mode) => typeof mode !== "string" || !Object.hasOwn(FULFILLMENT_MODES, mode));
  if (invalid !== undefined) return { ok: false, error: "Invalid business fulfillment option." };
  const modes = [...new Set(value)];
  if (modes.length === 0) return { ok: false, error: "Choose at least one way customers can use this business." };
  return { ok: true, modes };
}

module.exports = {
  FULFILLMENT_MODES,
  ORDER_FULFILLMENT_MODES,
  BOOKING_FULFILLMENT_MODES,
  CUSTOMER_COLLECTION_MODES,
  defaultFulfillmentModes,
  parseFulfillmentModes,
  normalizeFulfillmentModes,
};
