const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const pool = require("../db/pool");

const uploadDir = path.join(__dirname, "../../uploads");
async function cleanViewedOnceFiles() {
  if (!fs.existsSync(uploadDir)) return;

  try {
    // Get all view-once messages that have been viewed
    const result = await pool.query(
      `SELECT text FROM messages 
       WHERE text LIKE '[view-once]%' 
       AND viewed_at IS NOT NULL`
    );

    let deleted = 0;
    for (const row of result.rows) {
      try {
        // Extract filename from message text [view-once]url|filename
        const filename = row.text.split("|")[1];
        if (!filename) continue;
        const filepath = path.join(uploadDir, filename);
        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath);
          deleted++;
        }
      } catch {}
    }

    if (deleted > 0) {
      console.log(`[cleanup] Deleted ${deleted} viewed once-files`);
    }
  } catch (err) {
    console.error("[cleanup] Error:", err.message);
  }
}

function startCleanupScheduler() {
  // Run every hour — only cleans viewed view-once files
  cron.schedule("0 * * * *", () => {
    cleanViewedOnceFiles();
  });

  cleanViewedOnceFiles();
  console.log("[cleanup] Scheduler started — only viewed once-files will be auto-deleted");
}
function formatLastSeen(timestamp) {
  if (!timestamp) return "offline";
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "last seen just now";
  if (mins < 60) return `last seen ${mins}m ago`;
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${days}d ago`;
}
module.exports = { startCleanupScheduler };