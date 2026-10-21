const express = require("express");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { emitToUser } = require("../socket/realtime");
const { canBusinessTransition, toBookingDto } = require("../utils/bookingLifecycle");
const { BOOKING_FULFILLMENT_MODES, parseFulfillmentModes } = require("../utils/fulfillment");

const router = express.Router();
router.use(requireAuth);

const BOOKING_SELECT = `
  SELECT bk.id, bk.business_id, bk.customer_id, bk.slot_id, bk.service_item_id,
         bk.chat_id, bk.status, bk.notes, bk.created_at, bk.updated_at,
         bk.fulfillment_type, bk.service_address,
         bk.cancelled_at, bk.cancellation_reason, bs.start_at, bs.end_at,
         b.name AS business_name, b.user_id AS business_owner_id,
         u.username AS customer_name, mi.name AS service_name, mi.price AS service_price
  FROM bookings bk JOIN booking_slots bs ON bs.id=bk.slot_id
  JOIN businesses b ON b.id=bk.business_id JOIN users u ON u.id=bk.customer_id
  LEFT JOIN menu_items mi ON mi.id=bk.service_item_id`;

async function directChat(client, customerId, ownerId) {
  const key = [customerId, ownerId].sort().join(":");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  let found = await client.query("SELECT id FROM chats WHERE type='direct' AND direct_key=$1", [key]);
  if (found.rows[0]) return found.rows[0].id;
  const id = `chat_${randomUUID().split("-")[0]}`;
  await client.query("INSERT INTO chats (id,type,direct_key) VALUES ($1,'direct',$2)", [id, key]);
  await client.query("INSERT INTO chat_members (chat_id,user_id) VALUES ($1,$2),($1,$3)", [id, customerId, ownerId]);
  return id;
}

function emitBooking(req, row, event = "booking:updated") {
  const dto = toBookingDto(row);
  const io = req.app.get("io");
  emitToUser(io, row.customer_id, event, dto);
  emitToUser(io, row.business_owner_id, event, dto);
}

// Public availability for one verified business. Booked/expired slots never leak through.
router.get("/availability/:businessId", async (req, res) => {
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to - from > 31 * 86400000) {
    return res.status(400).json({ error: "A valid availability range of at most 31 days is required." });
  }
  try {
    const result = await pool.query(
      `SELECT s.id, s.start_at, s.end_at FROM booking_slots s
       JOIN businesses b ON b.id=s.business_id
       WHERE s.business_id=$1 AND b.verification_status='verified' AND s.enabled=TRUE
         AND b.fulfillment_modes ?| ARRAY['appointment','on_site_service']
         AND s.start_at >= GREATEST($2::timestamptz, NOW()) AND s.start_at < $3
         AND NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.slot_id=s.id AND bk.status IN ('pending','confirmed'))
       ORDER BY s.start_at`,
      [req.params.businessId, from.toISOString(), to.toISOString()]
    );
    res.json({ slots: result.rows.map((row) => ({ id: row.id, startAt: row.start_at, endAt: row.end_at })) });
  } catch (err) {
    console.error("[booking availability]", err.message);
    res.status(500).json({ error: "Could not load availability." });
  }
});

// Owner creates explicit future slots; duplicates are safely ignored.
router.post("/slots", async (req, res) => {
  const input = Array.isArray(req.body.slots) ? req.body.slots : [];
  if (!input.length || input.length > 100) return res.status(400).json({ error: "Provide between 1 and 100 slots." });
  const slots = input.map((slot) => ({ start: new Date(slot.startAt), end: new Date(slot.endAt) }));
  if (slots.some((slot) => !Number.isFinite(slot.start.getTime()) || !Number.isFinite(slot.end.getTime()) || slot.start <= new Date() || slot.end <= slot.start || slot.end - slot.start > 8 * 3600000)) {
    return res.status(400).json({ error: "Slots must be future times between 1 minute and 8 hours." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const biz = await client.query("SELECT id,type,fulfillment_modes FROM businesses WHERE user_id=$1", [req.user.userId]);
    if (!biz.rows[0]) throw Object.assign(new Error("Business not found."), { status: 404 });
    if (!parseFulfillmentModes(biz.rows[0].fulfillment_modes, biz.rows[0].type).some((mode) => BOOKING_FULFILLMENT_MODES.has(mode))) {
      throw Object.assign(new Error("Enable appointments or on-site service in business settings first."), { status: 400 });
    }
    const created = [];
    for (const slot of slots) {
      const id = `slot_${randomUUID().split("-")[0]}`;
      const result = await client.query(
        `INSERT INTO booking_slots (id,business_id,start_at,end_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (business_id,start_at) DO NOTHING RETURNING id,start_at,end_at`,
        [id, biz.rows[0].id, slot.start.toISOString(), slot.end.toISOString()]
      );
      if (result.rows[0]) created.push({ id: result.rows[0].id, startAt: result.rows[0].start_at, endAt: result.rows[0].end_at });
    }
    await client.query("COMMIT");
    res.status(201).json({ slots: created });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(err.status || 500).json({ error: err.status ? err.message : "Could not create slots." });
  } finally { client.release(); }
});

router.get("/slots/mine", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id,s.start_at,s.end_at,s.enabled,
              EXISTS(SELECT 1 FROM bookings bk WHERE bk.slot_id=s.id AND bk.status IN ('pending','confirmed')) AS booked
       FROM booking_slots s JOIN businesses b ON b.id=s.business_id
       WHERE b.user_id=$1 AND s.start_at >= NOW() ORDER BY s.start_at LIMIT 300`, [req.user.userId]
    );
    res.json({ slots: result.rows.map((row) => ({ id: row.id, startAt: row.start_at, endAt: row.end_at, enabled: row.enabled, booked: row.booked })) });
  } catch { res.status(500).json({ error: "Could not load slots." }); }
});

router.delete("/slots/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM booking_slots s USING businesses b WHERE s.id=$1 AND s.business_id=b.id AND b.user_id=$2
       AND NOT EXISTS(SELECT 1 FROM bookings bk WHERE bk.slot_id=s.id AND bk.status IN ('pending','confirmed')) RETURNING s.id`,
      [req.params.id, req.user.userId]
    );
    if (!result.rows[0]) return res.status(409).json({ error: "Slot was not found or has an active booking." });
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Could not remove slot." }); }
});

router.post("/", async (req, res) => {
  const { businessId, slotId, serviceItemId } = req.body;
  const notes = typeof req.body.notes === "string" ? req.body.notes.trim().slice(0, 1000) || null : null;
  const fulfillmentType = typeof req.body.fulfillmentType === "string" ? req.body.fulfillmentType.trim() : "appointment";
  const serviceAddress = typeof req.body.serviceAddress === "string" ? req.body.serviceAddress.trim().slice(0, 500) : "";
  if (typeof businessId !== "string" || typeof slotId !== "string") return res.status(400).json({ error: "Business and slot are required." });
  if (!BOOKING_FULFILLMENT_MODES.has(fulfillmentType)) return res.status(400).json({ error: "Choose a valid appointment type." });
  if (fulfillmentType === "on_site_service" && serviceAddress.length < 8) return res.status(400).json({ error: "Enter the address where the service is needed." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const slotResult = await client.query(
      `SELECT s.id,s.business_id,s.start_at,s.end_at,b.user_id,b.name,b.type,b.verification_status,b.fulfillment_modes
       FROM booking_slots s JOIN businesses b ON b.id=s.business_id
       WHERE s.id=$1 AND s.business_id=$2 AND s.enabled=TRUE FOR UPDATE OF s`, [slotId, businessId]
    );
    const slot = slotResult.rows[0];
    if (!slot) throw Object.assign(new Error("Booking slot not found."), { status: 404 });
    if (slot.verification_status !== "verified") throw Object.assign(new Error("Business is not verified for bookings."), { status: 403 });
    const offeredModes = parseFulfillmentModes(slot.fulfillment_modes, slot.type);
    if (!offeredModes.some((mode) => BOOKING_FULFILLMENT_MODES.has(mode))) {
      throw Object.assign(new Error("This business does not accept bookings."), { status: 400 });
    }
    if (!offeredModes.includes(fulfillmentType)) {
      throw Object.assign(new Error("This business does not offer that appointment type."), { status: 400 });
    }
    if (new Date(slot.start_at) <= new Date()) throw Object.assign(new Error("This slot has already started."), { status: 409 });
    if (slot.user_id === req.user.userId) throw Object.assign(new Error("You cannot book your own business."), { status: 400 });
    const blocked = await client.query(
      `SELECT 1 FROM blocked_users WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`,
      [req.user.userId, slot.user_id]
    );
    if (blocked.rows[0]) throw Object.assign(new Error("Booking is unavailable for this business."), { status: 403 });
    const active = await client.query("SELECT 1 FROM bookings WHERE slot_id=$1 AND status IN ('pending','confirmed')", [slotId]);
    if (active.rows[0]) throw Object.assign(new Error("That slot was just booked. Choose another time."), { status: 409 });
    if (serviceItemId != null) {
      const service = await client.query("SELECT 1 FROM menu_items WHERE id=$1 AND business_id=$2 AND available=TRUE", [serviceItemId, businessId]);
      if (!service.rows[0]) throw Object.assign(new Error("Selected service is unavailable."), { status: 400 });
    }
    const chatId = await directChat(client, req.user.userId, slot.user_id);
    const id = `booking_${randomUUID().split("-")[0]}`;
    await client.query(
      `INSERT INTO bookings (id,business_id,customer_id,slot_id,service_item_id,chat_id,notes,fulfillment_type,service_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id,businessId,req.user.userId,slotId,serviceItemId || null,chatId,notes,fulfillmentType,fulfillmentType === "on_site_service" ? serviceAddress : null]
    );
    const messageId = `msg_${randomUUID().split("-")[0]}`;
    const text = `[booking]${id}|${slot.name}|${new Date(slot.start_at).toISOString()}|pending`;
    const messageResult = await client.query(
      `INSERT INTO messages (id,chat_id,sender_id,client_message_id,text,status) VALUES ($1,$2,$3,$4,$5,'sent') RETURNING *`,
      [messageId, chatId, req.user.userId, `booking:${id}`, text]
    );
    await client.query("INSERT INTO message_receipts (message_id,user_id,status) VALUES ($1,$2,'sent')", [messageId, slot.user_id]);
    await client.query("UPDATE chats SET last_message_at=NOW() WHERE id=$1", [chatId]);
    const selected = await client.query(`${BOOKING_SELECT} WHERE bk.id=$1`, [id]);
    await client.query("COMMIT");
    const row = selected.rows[0];
    const messageRow = messageResult.rows[0];
    const message = {
      id: messageRow.id, clientMessageId: messageRow.client_message_id,
      client_message_id: messageRow.client_message_id, chatId, from: req.user.userId,
      sender_id: req.user.userId, sender_name: row.customer_name, text: messageRow.text,
      status: messageRow.status, created_at: messageRow.created_at, timestamp: messageRow.created_at,
      to: slot.user_id,
    };
    const io = req.app.get("io");
    emitToUser(io, req.user.userId, "message:sent", message);
    emitToUser(io, slot.user_id, "message:receive", message);
    emitBooking(req, row, "booking:created");
    res.status(201).json({ booking: toBookingDto(row), message });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[booking create]", err.message);
    res.status(err.code === "23505" ? 409 : err.status || 500).json({ error: err.code === "23505" ? "That slot was just booked." : err.status ? err.message : "Could not create booking." });
  } finally { client.release(); }
});

router.get("/mine", async (req, res) => {
  try {
    const result = await pool.query(`${BOOKING_SELECT} WHERE bk.customer_id=$1 ORDER BY bs.start_at DESC`, [req.user.userId]);
    res.json({ bookings: result.rows.map(toBookingDto) });
  } catch { res.status(500).json({ error: "Could not load bookings." }); }
});

router.get("/business", async (req, res) => {
  try {
    const result = await pool.query(`${BOOKING_SELECT} WHERE b.user_id=$1 ORDER BY bs.start_at DESC`, [req.user.userId]);
    res.json({ bookings: result.rows.map(toBookingDto) });
  } catch { res.status(500).json({ error: "Could not load bookings." }); }
});

async function updateStatus(req, res, customerCancel = false) {
  const next = customerCancel ? "cancelled" : req.body.status;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const where = customerCancel ? "bk.customer_id=$2" : "b.user_id=$2";
    const currentResult = await client.query(`${BOOKING_SELECT} WHERE bk.id=$1 AND ${where} FOR UPDATE OF bk`, [req.params.id, req.user.userId]);
    const current = currentResult.rows[0];
    if (!current) throw Object.assign(new Error("Booking not found."), { status: 404 });
    if (customerCancel ? !["pending", "confirmed"].includes(current.status) : !canBusinessTransition(current.status, next)) {
      throw Object.assign(new Error(`Booking cannot move from ${current.status} to ${next}.`), { status: 409 });
    }
    const reason = customerCancel ? (typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : "") || "Cancelled by customer" : next === "cancelled" ? "Cancelled by business" : null;
    await client.query(
      `UPDATE bookings SET status=$1,updated_at=NOW(),cancelled_at=CASE WHEN $1='cancelled' THEN NOW() ELSE cancelled_at END,
       cancellation_reason=CASE WHEN $1='cancelled' THEN $2 ELSE cancellation_reason END WHERE id=$3`, [next, reason, req.params.id]
    );
    await client.query("UPDATE messages SET text=regexp_replace(text, '\\|[^|]*$', '|' || $1) WHERE client_message_id=$2", [next, `booking:${req.params.id}`]);
    const updated = await client.query(`${BOOKING_SELECT} WHERE bk.id=$1`, [req.params.id]);
    await client.query("COMMIT");
    emitBooking(req, updated.rows[0]);
    res.json({ booking: toBookingDto(updated.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(err.status || 500).json({ error: err.status ? err.message : "Could not update booking." });
  } finally { client.release(); }
}

router.patch("/:id/status", (req, res) => updateStatus(req, res, false));
router.patch("/:id/cancel", (req, res) => updateStatus(req, res, true));

module.exports = router;
