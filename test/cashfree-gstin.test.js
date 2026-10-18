const test = require("node:test");
const assert = require("node:assert/strict");
const {
  businessNamesMatch,
  normalizeBusinessName,
  normalizeRegistryDate,
} = require("../src/services/cashfreeGstin");

test("GSTIN business-name matching tolerates legal suffixes", () => {
  assert.equal(businessNamesMatch("Ujjivan Small Finance Bank", "UJJIVAN SMALL FINANCE BANK LIMITED"), true);
  assert.equal(businessNamesMatch("Sharma Dhaba", "SHARMA DHABA PRIVATE LIMITED"), true);
});

test("GSTIN business-name matching flags unrelated registrations", () => {
  assert.equal(businessNamesMatch("Sharma Dhaba", "AMAZON SELLER SERVICES PRIVATE LIMITED"), false);
});

test("GSTIN name normalization removes punctuation and legal suffixes", () => {
  assert.equal(normalizeBusinessName("Example & Sons Pvt. Ltd."), "example sons");
});

test("Cashfree registration dates are normalized for PostgreSQL", () => {
  assert.equal(normalizeRegistryDate("03/07/2017"), "2017-07-03");
  assert.equal(normalizeRegistryDate("2017-07-03"), "2017-07-03");
  assert.equal(normalizeRegistryDate("31/02/2017"), null);
  assert.equal(normalizeRegistryDate("unknown"), null);
});
