require("dotenv").config();
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

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
    await client.query(`CREATE DATABASE ${process.env.DB_NAME}`);
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

  // Apply any incremental migrations in order (e.g. business verification
  // columns). Each file must be idempotent (IF NOT EXISTS / DO blocks) since
  // the whole folder re-runs every time migrate.js is invoked.
  const migrationsDir = path.join(__dirname, "migrations");
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await appClient.query(sql);
      console.log(`[migrate] Applied ${file}`);
    }
  }

  await appClient.end();
  console.log("[migrate] Done ✓");
}

migrate().catch((err) => {
  console.error("[migrate] Failed:", err.message);
  process.exit(1);
});