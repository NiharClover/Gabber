const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

test("migrated database contains P0-P4 integrity structures", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  const client = new Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await client.connect();
  try {
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'
       AND table_name=ANY($1::text[])`,
      [["schema_migrations", "message_receipts", "booking_slots", "bookings", "ad_events"]]
    );
    assert.deepEqual(new Set(tables.rows.map((row) => row.table_name)), new Set(["schema_migrations", "message_receipts", "booking_slots", "bookings", "ad_events"]));
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'
       AND indexname=ANY($1::text[])`, [["uq_chats_direct_key", "uq_bookings_active_slot", "idx_businesses_discovery"]]
    );
    assert.equal(indexes.rows.length, 3);
    const migrations = await client.query("SELECT COUNT(*)::int AS count FROM schema_migrations");
    assert.ok(migrations.rows[0].count >= 7);
    const businessColumns = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public'
       AND table_name='businesses' AND column_name=ANY($1::text[])`,
      [["gstin_reference_id", "gstin_registry_status", "gstin_name_match", "gstin_checked_at"]]
    );
    assert.equal(businessColumns.rows.length, 4);
  } finally { await client.end(); }
});
