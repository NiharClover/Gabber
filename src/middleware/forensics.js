const pool = require("../db/pool");

async function requireForensics(req, res, next) {
  try {
    const result = await pool.query(
      "SELECT is_admin, can_access_forensics FROM users WHERE id=$1",
      [req.user.userId]
    );
    const user = result.rows[0];
    if (!user?.is_admin || !user?.can_access_forensics) {
      return res.status(403).json({ error: "Forensic authorization required." });
    }
    next();
  } catch (err) {
    console.error("[forensics middleware]", err.message);
    res.status(500).json({ error: "Server error." });
  }
}

module.exports = { requireForensics };
