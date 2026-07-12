require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
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




app.use("/api/blocks", blocksRouter);
app.use(cors());
app.use(express.json());
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