const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOrderItems } = require("../src/utils/orderValidation");
const { isAdEligible } = require("../src/utils/adTargeting");
const { normalizeGroupCreationInput } = require("../src/utils/groupValidation");
const { normalizeBusinessDetails, normalizeMenuItem } = require("../src/utils/businessValidation");
const { canBusinessTransition, toOrderDto } = require("../src/utils/orderLifecycle");
const { canBusinessTransition: canBookingTransition, toBookingDto } = require("../src/utils/bookingLifecycle");
const { normalizeAd, toAdDto } = require("../src/utils/adLifecycle");

test("order quantities must be positive bounded integers", () => {
  assert.equal(normalizeOrderItems([{ id: "item_1", qty: 1 }]).ok, true);
  assert.equal(normalizeOrderItems([{ id: "item_1", qty: 0 }]).ok, false);
  assert.equal(normalizeOrderItems([{ id: "item_1", qty: -2 }]).ok, false);
  assert.equal(normalizeOrderItems([{ id: "item_1", qty: 1.5 }]).ok, false);
  assert.equal(normalizeOrderItems([{ id: "item_1", qty: 101 }]).ok, false);
});

test("duplicate order items are rejected", () => {
  assert.equal(normalizeOrderItems([{ id: "item_1", qty: 1 }, { id: "item_1", qty: 2 }]).ok, false);
});

test("targeted ads fail closed without matching location context", () => {
  const targeted = { target_city: "Pune", target_pincode: null, target_lat: null, target_lng: null };
  assert.equal(isAdEligible(targeted, { city: "", pincode: "", hasCoordinates: false }), false);
  assert.equal(isAdEligible(targeted, { city: "pune", pincode: "", hasCoordinates: false }), true);
});

test("untargeted ads remain globally eligible", () => {
  const globalAd = { target_city: null, target_pincode: null, target_lat: null, target_lng: null };
  assert.equal(isAdEligible(globalAd, { city: "", pincode: "", hasCoordinates: false }), true);
});

test("group creation accepts the memberPhones contract used by the app", () => {
  const result = normalizeGroupCreationInput({
    name: " Friends ",
    memberPhones: ["+919876543210"],
  });
  assert.deepEqual(result, {
    ok: true,
    name: "Friends",
    memberPhones: ["+919876543210"],
    memberIds: [],
  });
});

test("group creation accepts contact-picker user IDs", () => {
  assert.deepEqual(normalizeGroupCreationInput({ name: "Team", memberIds: ["user_1", "user_2", "user_1"] }), {
    ok: true, name: "Team", memberPhones: [], memberIds: ["user_1", "user_2"],
  });
});

test("group creation rejects empty or malformed member lists", () => {
  assert.equal(normalizeGroupCreationInput({ name: "Friends", memberPhones: [] }).ok, false);
  assert.equal(normalizeGroupCreationInput({ name: "Friends", memberPhones: ["9876543210"] }).ok, false);
});

test("business and catalogue input is normalized and bounded", () => {
  assert.equal(normalizeBusinessDetails({ name: " Test Shop ", type: "shop", phone: "+919876543210", pincode: "411001" }).ok, true);
  assert.equal(normalizeBusinessDetails({ name: "X", type: "shop" }).ok, false);
  assert.equal(normalizeMenuItem({ name: "Tea", price: 20.5, available: false }).ok, true);
  assert.equal(normalizeMenuItem({ name: "Tea", price: -1 }).ok, false);
});

test("order lifecycle permits only forward owner transitions", () => {
  assert.equal(canBusinessTransition("pending", "confirmed"), true);
  assert.equal(canBusinessTransition("confirmed", "pending"), false);
  assert.equal(canBusinessTransition("delivered", "cancelled"), false);
});

test("order responses expose stable typed values", () => {
  const dto = toOrderDto({
    id: "order_1", status: "pending", items: JSON.stringify([{ id: "i1", name: "Tea", price: "20.50", qty: 2 }]),
    total: "41.00", business_id: "biz_1", customer_id: "user_1", created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(dto.total, 41);
  assert.equal(dto.items[0].unitPrice, 20.5);
  assert.equal(dto.items[0].quantity, 2);
  assert.equal(dto.items[0].subtotal, 41);
  assert.equal(dto.capabilities.customerCanCancel, true);
});

test("booking lifecycle is forward-only and exposes customer capabilities", () => {
  assert.equal(canBookingTransition("pending", "confirmed"), true);
  assert.equal(canBookingTransition("confirmed", "pending"), false);
  const dto = toBookingDto({
    id: "booking_1", status: "pending", business_id: "biz_1", business_name: "Salon",
    business_owner_id: "owner_1", customer_id: "user_1", customer_name: "Asha",
    slot_id: "slot_1", start_at: "2026-10-01T10:00:00.000Z", end_at: "2026-10-01T10:30:00.000Z",
    service_item_id: "item_1", service_name: "Haircut", service_price: "250.00",
    created_at: "2026-09-20T10:00:00.000Z",
  });
  assert.equal(dto.service.price, 250);
  assert.equal(dto.capabilities.customerCanCancel, true);
  assert.deepEqual(dto.capabilities.businessNextStatuses, ["confirmed", "rejected"]);
});

test("promotions validate placements, budgets and CTA URLs", () => {
  assert.equal(normalizeAd({ title: "Local offer", description: "Today only", adType: "explore", budgetTotal: 500, bidAmount: 2 }).ok, true);
  assert.equal(normalizeAd({ title: "Local offer", description: "Today only", adType: "story", budgetTotal: 500 }).ok, false);
  assert.equal(normalizeAd({ title: "Local offer", description: "Today only", ctaUrl: "javascript:alert(1)", budgetTotal: 500 }).ok, false);
});

test("promotion responses use a stable typed contract", () => {
  const ad = toAdDto({ id: "ad_1", business_id: "biz_1", business_name: "Cafe", ad_type: "card", title: "Tea", cta_text: "Visit", budget_total: "500.00", budget_remaining: "498.00", bid_amount: "2.00", impressions: "3", clicks: "1", active: true });
  assert.equal(ad.placement, "chat_list");
  assert.equal(ad.budget.remaining, 498);
  assert.equal(ad.analytics.impressions, 3);
});
