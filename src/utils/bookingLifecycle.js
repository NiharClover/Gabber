const BUSINESS_TRANSITIONS = Object.freeze({
  pending: new Set(["confirmed", "rejected"]),
  confirmed: new Set(["completed", "cancelled"]),
  completed: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
});

function canBusinessTransition(from, to) {
  return BUSINESS_TRANSITIONS[from]?.has(to) === true;
}

function toBookingDto(row) {
  const status = row.status;
  return {
    id: row.id,
    status,
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    cancelledAt: row.cancelled_at || null,
    cancellationReason: row.cancellation_reason || null,
    chatId: row.chat_id || null,
    fulfillmentType: row.fulfillment_type || "appointment",
    serviceAddress: row.service_address || null,
    slot: { id: row.slot_id, startAt: row.start_at, endAt: row.end_at },
    service: row.service_item_id ? {
      id: row.service_item_id,
      name: row.service_name || null,
      price: row.service_price == null ? null : Number(row.service_price),
    } : null,
    business: { id: row.business_id, name: row.business_name, ownerId: row.business_owner_id },
    customer: { id: row.customer_id, name: row.customer_name },
    capabilities: {
      customerCanCancel: status === "pending" || status === "confirmed",
      businessNextStatuses: [...(BUSINESS_TRANSITIONS[status] || [])],
    },
  };
}

module.exports = { BUSINESS_TRANSITIONS, canBusinessTransition, toBookingDto };
