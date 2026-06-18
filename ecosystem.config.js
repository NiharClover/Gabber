module.exports = {
  apps: [{
    name: "gabber",
    script: "src/server.js",
    instances: "max",
    exec_mode: "cluster",
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