require("dotenv").config();
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

async function migrate() {
  // First connect to default 'postgres' db to create our db if needed
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: "postgres",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  await client.connect();

  // Create database if it doesn't exist
  const exists = await client.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`, 
    [process.env.DB_NAME]
  );

  if (exists.rows.length === 0) {
    if (!/^[a-zA-Z0-9_]+$/.test(process.env.DB_NAME || "")) throw new Error("DB_NAME contains unsupported characters.");
    await client.query(`CREATE DATABASE "${process.env.DB_NAME}"`);
    console.log(`[migrate] Database '${process.env.DB_NAME}' created`);
  } else {
    console.log(`[migrate] Database '${process.env.DB_NAME}' already exists`);
  }

  await client.end();

  // Now connect to gabber db and run schema
  const appClient = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  await appClient.connect();

  const schema = fs.readFileSync(
    path.join(__dirname, "schema.sql"), 
    "utf8"
  );
  await appClient.query(schema);
  console.log("[migrate] Base schema applied successfully");

  await appClient.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Each incremental migration is recorded with a checksum and applied in
  // its own transaction. Existing installations safely run the historical
  // idempotent migrations once to seed this ledger; later runs skip them.
  const migrationsDir = path.join(__dirname, "migrations");
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await appClient.query("SELECT checksum FROM schema_migrations WHERE filename=$1", [file]);
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} has been modified.`);
        console.log(`[migrate] Skipped ${file}`);
        continue;
      }
      await appClient.query("BEGIN");
      try {
        await appClient.query(sql);
        await appClient.query("INSERT INTO schema_migrations (filename,checksum) VALUES ($1,$2)", [file, checksum]);
        await appClient.query("COMMIT");
        console.log(`[migrate] Applied ${file}`);
      } catch (err) {
        await appClient.query("ROLLBACK");
        throw err;
      }
    }
  }

  await appClient.end();
  console.log("[migrate] Done ✓");
}

migrate().catch((err) => {
  console.error("[migrate] Failed:", err.message);
  process.exit(1);
});
