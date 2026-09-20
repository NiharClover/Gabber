function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
}

function normalizeGroupCreationInput(body = {}) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "Enter a group name." };
  if (name.length > 100) return { ok: false, error: "Group name must be 100 characters or less." };

  const memberPhones = normalizeStringList(body.memberPhones);
  const memberIds = normalizeStringList(body.memberIds);
  if (memberPhones.length === 0 && memberIds.length === 0) {
    return { ok: false, error: "Add at least one member." };
  }
  if (memberPhones.length + memberIds.length > 256) {
    return { ok: false, error: "A group can have at most 256 selected members." };
  }
  if (memberPhones.some((phone) => !/^\+[1-9]\d{9,14}$/.test(phone))) {
    return { ok: false, error: "Member phone numbers must use international format, for example +919876543210." };
  }

  return { ok: true, name, memberPhones, memberIds };
}

module.exports = { normalizeGroupCreationInput };
