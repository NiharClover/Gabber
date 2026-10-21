const BUSINESS_TRANSITIONS = Object.freeze({
  pending: new Set(["confirmed", "cancelled"]),
  confirmed: new Set(["preparing", "ready", "cancelled"]),
  preparing: new Set(["ready", "cancelled"]),
  ready: new Set(),
  delivered: new Set(),
  collected: new Set(),
  cancelled: new Set(),
});
const { CUSTOMER_COLLECTION_MODES } = require("./fulfillment");

function getBusinessNextStatuses(status, fulfillmentType = "merchant_delivery") {
  if (status === "ready" && fulfillmentType === "merchant_delivery") return ["delivered"];
  return [...(BUSINESS_TRANSITIONS[status] || [])];
}

function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeOrderItem(item) {
  const unitPrice = Number(item.unitPrice ?? item.price ?? 0);
  const quantity = Number(item.quantity ?? item.qty ?? 0);
  return {
    id: item.id == null ? null : String(item.id),
    name: String(item.name || ""),
    description: item.description || null,
    category: item.category || "General",
    unitPrice,
    quantity,
    subtotal: Number(item.subtotal ?? unitPrice * quantity),
  };
}

function toOrderDto(row) {
  const fulfillmentType = row.fulfillment_type || "merchant_delivery";
  return {
    id: row.id,
    status: row.status,
    items: parseItems(row.items).map(normalizeOrderItem),
    total: Number(row.total),
    notes: row.notes || null,
    chatId: row.chat_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    cancelledAt: row.cancelled_at || null,
    cancellationReason: row.cancellation_reason || null,
    collectedAt: row.collected_at || null,
    fulfillmentType,
    business: {
      id: row.business_id,
      name: row.business_name || null,
      ownerId: row.business_owner_id || null,
    },
    customer: {
      id: row.customer_id,
      name: row.customer_name || null,
    },
    capabilities: {
      customerCanCancel: row.status === "pending" || row.status === "confirmed",
      customerCanConfirmCollection: row.status === "ready" && CUSTOMER_COLLECTION_MODES.has(fulfillmentType),
      businessNextStatuses: getBusinessNextStatuses(row.status, fulfillmentType),
    },
  };
}

function canBusinessTransition(from, to, fulfillmentType = "merchant_delivery") {
  return getBusinessNextStatuses(from, fulfillmentType).includes(to);
}

module.exports = { BUSINESS_TRANSITIONS, getBusinessNextStatuses, canBusinessTransition, toOrderDto };
