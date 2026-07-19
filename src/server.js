require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
// SECURITY: adds baseline HTTP security headers (X-Content-Type-Options,
// X-Frame-Options, etc). Run `npm install helmet` if this errors on start —
// it isn't in package.json yet.
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
const { registerHandlers } = require("./socket/handlers");
const { verifySocketToken } = require("./middleware/auth");
const { startCleanupScheduler } = require("./services/cleanup");
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
const blocksRouter = require("./routes/blocks");
const safetyRouter = require("./routes/safety");
const adminRouter = require("./routes/admin");

// Set to "false" in .env to temporarily disable business features
// (routes + registration) without deleting any code.
const BUSINESS_ENABLED = process.env.FEATURE_BUSINESS_ENABLED !== "false";




app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // media/avatars are meant to load cross-origin (in the mobile app's webview-free Image component and, soon, the admin panel)
}));

// SECURITY FIX: was `cors()` with no options, which reflects ANY origin.
// Mobile apps don't send an Origin header so this never affected them either
// way — but it meant any website's JavaScript could hit this API using a
// stolen/leaked token. Locking to an explicit allowlist. The admin panel is
// served from this same Express app (see bottom of file) so it never needs
// to be in this list — it's same-origin.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header at all = non-browser client (the mobile app, curl,
    // server-to-server) — always allow, CORS is a browser-only concept.
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) {
      // Nothing configured yet — stay permissive rather than silently
      // breaking an unconfigured deployment, but log so it's visible.
      console.warn("[cors] ALLOWED_ORIGINS not set — allowing all origins. Set it before going to production.");
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
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
} else {
  console.log("[server] Business features disabled (FEATURE_BUSINESS_ENABLED=false)");
}
app.use("/api/safety", safetyRouter);
app.use("/api/admin", adminRouter);
app.use("/uploads/avatars", express.static(path.join(__dirname, "../uploads/avatars")));

// Admin panel — served from this same Express app so it's same-origin with
// the API (no CORS wrinkles, no separate hosting/deployment). The page
// itself is publicly loadable, but it's just a login screen + fetch calls —
// every actual data endpoint is still gated behind requireAuth + requireAdmin
// server-side, so loading the HTML reveals nothing on its own.
app.use("/admin", express.static(path.join(__dirname, "../public/admin")));

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Gabber server running on http://localhost:${PORT}`);
});