const Redis = require("ioredis");

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => {
    if (times > 3) {
      console.error("[redis] Could not connect after 3 retries");
      return null;
    }
    return Math.min(times * 200, 2000);
  },
});

redis.on("connect", () => console.log("[redis] Connected"));
redis.on("error", (err) => console.error("[redis] Error:", err.message));

module.exports = redis;