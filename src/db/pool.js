const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,                // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error:", err.message);
});

// Test connection on startup
pool.query("SELECT NOW()").then(() => {
  console.log("[db] PostgreSQL connected");
}).catch((err) => {
  console.error("[db] Connection failed:", err.message);
});

module.exports = pool;