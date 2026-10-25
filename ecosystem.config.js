require("dotenv").config({
  path: require("path").join(__dirname, ".env"),
  override: true,
});

module.exports = {
  apps: [{
    name: "gabber",
    script: "src/server.js",
    // Call sessions and Socket.IO presence are currently process-local.
    // Keep one realtime process until both the Socket.IO adapter and call
    // session store are moved to Redis; cluster mode splits active rooms.
    instances: 1,
    exec_mode: "fork",
    env: {
      // Pass the server .env mode through to PM2; default safely to production.
      NODE_ENV: process.env.NODE_ENV || "production",
      DEV_MODE: process.env.DEV_MODE || "false",
      PORT: 3000,
    },
    error_file: "./logs/err.log",
    out_file: "./logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    restart_delay: 3000,
    max_restarts: 10,
  }]
};
