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
      NODE_ENV: "production",
      PORT: 3000,
    },
    error_file: "./logs/err.log",
    out_file: "./logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    restart_delay: 3000,
    max_restarts: 10,
  }]
};
