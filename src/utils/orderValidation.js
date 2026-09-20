function normalizeOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    return { ok: false, error: "1-50 items are required." };
  }
  const normalized = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100) {
      return { ok: false, error: "Each item requires a valid id and an integer quantity from 1 to 100." };
    }
    if (seen.has(item.id)) return { ok: false, error: "Duplicate items are not allowed." };
    seen.add(item.id);
    normalized.push({ id: item.id, qty: item.qty });
  }
  return { ok: true, items: normalized };
}

module.exports = { normalizeOrderItems };
