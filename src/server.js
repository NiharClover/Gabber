require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const multer = require("multer");
const { Server } = require("socket.io");
const cors = require("cors");
// Adds baseline HTTP security headers (X-Content-Type-Options,
// X-Frame-Options, etc.). Helmet is a declared runtime dependency.
const helmet = require("helmet");
const healthRouter = require("./routes/health");
const authRouter = require("./routes/auth");
const chatsRouter = require("./routes/chats");
const groupsRouter = require("./routes/groups");
const stickersRouter = require("./routes/stickers");
const devicesRouter = require("./routes/devices");
const contactsRouter = require("./routes/contacts");
const mediaRouter = require("./routes/media");
const voiceRouter = require("./routes/voice");
const statusRouter = require("./routes/status");
const profileRouter = require("./routes/profile");
const businessRouter = require("./routes/business");
const ordersRouter = require("./routes/orders");
const adsRouter = require("./routes/ads");
const discoveryRouter = require("./routes/discovery");
const bookingsRouter = require("./routes/bookings");
const { registerHandlers } = require("./socket/handlers");
const { verifySocketToken } = require("./middleware/auth");
const { startCleanupScheduler } = require("./services/cleanup");

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || /^(replace|change|generate)/i.test(process.env.JWT_SECRET)) {
  throw new Error("JWT_SECRET must be configured with at least 32 characters.");
}
if (process.env.NODE_ENV === "production" && process.env.DEV_MODE === "true") {
  throw new Error("DEV_MODE=true is forbidden in production.");
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
if (process.env.NODE_ENV === "production" && allowedOrigins.length === 0) {
  throw new Error("ALLOWED_ORIGINS must contain the production API/admin origin.");
}
const allowUnconfiguredDevelopmentOrigin = process.env.NODE_ENV !== "production" && allowedOrigins.length === 0;
function originAllowed(origin) {
  return !origin || allowUnconfiguredDevelopmentOrigin || allowedOrigins.includes(origin);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => originAllowed(origin)
      ? callback(null, true)
      : callback(new Error("Origin not allowed by Socket.IO CORS")),
    methods: ["GET", "POST"],
  },
});
app.set("io", io);
if (process.env.TRUST_PROXY_HOPS) {
  const hops = Number.parseInt(process.env.TRUST_PROXY_HOPS, 10);
  if (!Number.isInteger(hops) || hops < 1 || hops > 5) throw new Error("TRUST_PROXY_HOPS must be between 1 and 5.");
  app.set("trust proxy", hops);
}
const safetyRouter = require("./routes/safety");
const adminRouter = require("./routes/admin");

// Set to "false" in .env to temporarily disable business features
// (routes + registration) without deleting any code.
const BUSINESS_ENABLED = process.env.FEATURE_BUSINESS_ENABLED !== "false";




app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // media/avatars are meant to load cross-origin (in the mobile app's webview-free Image component and, soon, the admin panel)
}));

// SECURITY FIX: was `cors()` with no options, which reflects ANY origin.
// Native mobile requests normally have no Origin header, while browser and
// Socket.IO clients must match ALLOWED_ORIGINS in production. The admin panel
// is served from this Express app; include the public server origin in the
// allowlist because browser requests can still carry an Origin header.
app.use(cors({
  origin: (origin, callback) => {
    if (originAllowed(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
}));

// SECURITY FIX: no body size limit meant a client could POST an arbitrarily
// large JSON payload (message text, business registration fields, etc.) and
// tie up server memory/CPU parsing it. 2mb is generous for any legitimate
// JSON body here — actual file uploads go through multer's own limits, not
// this one.
app.use(express.json({ limit: "2mb" }));

app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use("/api", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/chats", chatsRouter);
app.use("/api/groups", groupsRouter);
app.use("/api/stickers", stickersRouter);
app.use("/api/devices", devicesRouter);
app.use("/api/contacts", contactsRouter);
app.use("/api/media", mediaRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/status", statusRouter);
app.use("/api/profile", profileRouter);
if (BUSINESS_ENABLED) {
  app.use("/api/business", businessRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/ads", adsRouter);
  app.use("/api/discovery", discoveryRouter);
  app.use("/api/bookings", bookingsRouter);
} else {
  console.log("[server] Business features disabled (FEATURE_BUSINESS_ENABLED=false)");
}
app.use("/api/safety", safetyRouter);
app.use("/api/admin", adminRouter);

// Admin panel — served from this same Express app so it's same-origin with
// the API (no CORS wrinkles, no separate hosting/deployment). The page
// itself is publicly loadable, but it's just a login screen + fetch calls —
// every actual data endpoint is still gated behind requireAuth + requireAdmin
// server-side, so loading the HTML reveals nothing on its own.
app.use("/admin", express.static(path.join(__dirname, "../public/admin")));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /Only .* (allowed|files)/i.test(err?.message || "")) {
    return res.status(400).json({ error: err.message || "Invalid upload." });
  }
  console.error("[http] Unhandled request error:", err?.message || err);
  return res.status(500).json({ error: "Server error." });
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication required."));
  try {
    socket.user = verifySocketToken(token);
    next();
  } catch {
    next(new Error("Invalid token."));
  }
});

io.on("connection", (socket) => {
  socket.userId = socket.user.userId;
  socket.username = socket.user.username;
  registerHandlers(io, socket);
});

startCleanupScheduler();

// AppSail injects X_ZOHO_CATALYST_LISTEN_PORT. Keep PORT as the fallback for
// local development and other hosting environments.
const PORT = process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Gabber server running on http://localhost:${PORT}`);
});
