const pool = require("../db/pool");

// The JWT payload only carries { userId, phone } (see routes/auth.js), so
// admin status is looked up fresh from the DB on every request rather than
// trusted from the token — this means revoking admin access takes effect
// immediately without needing users to re-login.
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query(
      "SELECT is_admin FROM users WHERE id = $1",
      [req.user.userId]
    );
    if (!result.rows[0]?.is_admin) {
      return res.status(403).json({ error: "Admin access required." });
    }
    next();
  } catch (err) {
    console.error("[admin middleware]", err.message);
    res.status(500).json({ error: "Server error." });
  }
}

module.exports = { requireAdmin };