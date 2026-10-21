const express = require("express");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { normalizeOrderItems } = require("../utils/orderValidation");
const { canBusinessTransition, toOrderDto } = require("../utils/orderLifecycle");
const { ORDER_FULFILLMENT_MODES, CUSTOMER_COLLECTION_MODES, parseFulfillmentModes } = require("../utils/fulfillment");
const { emitToUser } = require("../socket/realtime");

const router = express.Router();
router.use(requireAuth);

const ORDER_SELECT = `
  SELECT o.id, o.business_id, o.customer_id, o.chat_id, o.items, o.total,
         o.status, o.notes, o.created_at, o.updated_at, o.cancelled_at,
         o.cancellation_reason, o.fulfillment_type, o.collected_at, b.name AS business_name,
         b.user_id AS business_owner_id, u.username AS customer_name
  FROM orders o
  JOIN businesses b ON b.id=o.business_id
  JOIN users u ON u.id=o.customer_id
`;

async function getOrCreateDirectChat(client, userA, userB) {
  const directKey = [userA, userB].sort().join(":");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [directKey]);
  let result = await client.query(
    "SELECT id FROM chats WHERE type='direct' AND direct_key=$1 LIMIT 1",
    [directKey]
  );
  if (!result.rows[0]) {
    result = await client.query(
      `SELECT c.id FROM chats c
       JOIN chat_members a ON a.chat_id=c.id AND a.user_id=$1
       JOIN chat_members b ON b.chat_id=c.id AND b.user_id=$2
       WHERE c.type='direct' ORDER BY c.created_at ASC LIMIT 1`,
      [userA, userB]
    );
    if (result.rows[0]) {
      await client.query(
        "UPDATE chats SET direct_key=$1 WHERE id=$2 AND direct_key IS NULL",
        [directKey, result.rows[0].id]
      );
    }
  }
  if (result.rows[0]) return result.rows[0].id;

  const chatId = `chat_${randomUUID().split("-")[0]}`;
  await client.query("INSERT INTO chats (id, type, direct_key) VALUES ($1,'direct',$2)", [chatId, directKey]);
  await client.query(
    "INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2),($1,$3)",
    [chatId, userA, userB]
  );
  return chatId;
}

async function resolveOrderChat(client, requestedChatId, customerId, businessOwnerId) {
  if (requestedChatId != null) {
    if (typeof requestedChatId !== "string") throw Object.assign(new Error("chatId must be a string."), { status: 400 });
    const chat = await client.query(
      `SELECT c.id FROM chats c WHERE c.id=$1 AND c.type='direct'
         AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=c.id AND user_id=$2)
         AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=c.id AND user_id=$3)`,
      [requestedChatId, customerId, businessOwnerId]
    );
    if (!chat.rows[0]) {
      throw Object.assign(new Error("That chat does not belong to this customer and business."), { status: 403 });
    }
    return requestedChatId;
  }
  return getOrCreateDirectChat(client, customerId, businessOwnerId);
}

function emitOrderUpdate(req, row, event = "order:updated") {
  const io = req.app.get("io");
  const dto = toOrderDto(row);
  emitToUser(io, row.customer_id, event, dto);
  emitToUser(io, row.business_owner_id, event, dto);
}

// Creates the canonical customer/business chat, the order, and its bill
// message in one transaction. There is no client-side best-effort gap.
router.post("/", async (req, res) => {
  const { businessId, chatId, items, notes, fulfillmentType } = req.body;
  if (typeof businessId !== "string") return res.status(400).json({ error: "businessId is required." });
  const validation = normalizeOrderItems(items);
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const businessResult = await client.query(
      "SELECT id, user_id, name, type, verification_status, fulfillment_modes FROM businesses WHERE id=$1 FOR SHARE",
      [businessId]
    );
    const business = businessResult.rows[0];
    if (!business) throw Object.assign(new Error("Business not found."), { status: 404 });
    if (business.user_id === req.user.userId) {
      throw Object.assign(new Error("You cannot place an order with your own business."), { status: 400 });
    }
    if (business.verification_status !== "verified") {
      throw Object.assign(new Error("This business is not currently verified to accept orders."), { status: 403 });
    }
    const enabledOrderModes = parseFulfillmentModes(business.fulfillment_modes, business.type)
      .filter((mode) => ORDER_FULFILLMENT_MODES.has(mode));
    if (enabledOrderModes.length === 0) {
      throw Object.assign(new Error("This business currently accepts enquiries or bookings, not product orders."), { status: 409 });
    }
    const selectedFulfillment = fulfillmentType || enabledOrderModes[0];
    if (!ORDER_FULFILLMENT_MODES.has(selectedFulfillment) || !enabledOrderModes.includes(selectedFulfillment)) {
      throw Object.assign(new Error("Choose one of the fulfillment options offered by this business."), { status: 400 });
    }
    const blocked = await client.query(
      `SELECT 1 FROM blocked_users
       WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`,
      [req.user.userId, business.user_id]
    );
    if (blocked.rows[0]) throw Object.assign(new Error("Ordering is unavailable for this business."), { status: 403 });

    const normalizedItems = validation.items;
    const menuResult = await client.query(
      `SELECT id, name, description, price, category FROM menu_items
       WHERE id=ANY($1::varchar[]) AND business_id=$2 AND available=TRUE`,
      [normalizedItems.map((item) => item.id), businessId]
    );
    if (menuResult.rows.length !== normalizedItems.length) {
      throw Object.assign(new Error("One or more items are unavailable or invalid for this business."), { status: 400 });
    }

    const menuMap = new Map(menuResult.rows.map((item) => [item.id, item]));
    let totalCents = 0;
    const orderItems = normalizedItems.map((item) => {
      const menuItem = menuMap.get(item.id);
      const unitPriceCents = Math.round(Number(menuItem.price) * 100);
      const subtotalCents = unitPriceCents * item.qty;
      totalCents += subtotalCents;
      return {
        id: menuItem.id,
        name: menuItem.name,
        description: menuItem.description,
        category: menuItem.category,
        unitPrice: unitPriceCents / 100,
        quantity: item.qty,
        subtotal: subtotalCents / 100,
      };
    });
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      throw Object.assign(new Error("Order total is invalid."), { status: 400 });
    }

    const authorizedChatId = await resolveOrderChat(client, chatId, req.user.userId, business.user_id);
    const orderId = `order_${randomUUID().split("-")[0]}`;
    await client.query(
      `INSERT INTO orders (id, business_id, customer_id, chat_id, items, total, notes, fulfillment_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orderId, businessId, req.user.userId, authorizedChatId, JSON.stringify(orderItems),
        (totalCents / 100).toFixed(2), typeof notes === "string" ? notes.trim().slice(0, 1000) || null : null,
        selectedFulfillment]
    );

    const summary = orderItems.map((item) => `${item.quantity}x ${item.name} ₹${item.subtotal.toFixed(2)}`).join(", ");
    const billText = `[bill]${orderId}|${business.name}|${summary}|₹${(totalCents / 100).toFixed(2)}|pending`;
    const messageId = `msg_${randomUUID().split("-")[0]}`;
    const messageResult = await client.query(
      `INSERT INTO messages (id, chat_id, sender_id, client_message_id, text, status)
       VALUES ($1,$2,$3,$4,$5,'sent') RETURNING *`,
      [messageId, authorizedChatId, req.user.userId, `order:${orderId}`, billText]
    );
    await client.query(
      "INSERT INTO message_receipts (message_id, user_id, status) VALUES ($1,$2,'sent')",
      [messageId, business.user_id]
    );
    await client.query("UPDATE chats SET last_message_at=NOW() WHERE id=$1", [authorizedChatId]);

    const orderResult = await client.query(`${ORDER_SELECT} WHERE o.id=$1`, [orderId]);
    await client.query("COMMIT");

    const row = orderResult.rows[0];
    const order = toOrderDto(row);
    const messageRow = messageResult.rows[0];
    const message = {
      id: messageRow.id,
      clientMessageId: messageRow.client_message_id,
      client_message_id: messageRow.client_message_id,
      chatId: messageRow.chat_id,
      from: messageRow.sender_id,
      sender_id: messageRow.sender_id,
      sender_name: row.customer_name,
      text: messageRow.text,
      status: messageRow.status,
      created_at: messageRow.created_at,
      timestamp: messageRow.created_at,
      to: business.user_id,
    };
    const io = req.app.get("io");
    emitToUser(io, req.user.userId, "message:sent", message);
    emitToUser(io, business.user_id, "message:receive", message);
    emitToUser(io, business.user_id, "order:created", order);
    res.status(201).json({ success: true, order, message });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[orders]", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Server error." });
  } finally {
    client.release();
  }
});

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`${ORDER_SELECT} WHERE o.customer_id=$1 ORDER BY o.created_at DESC`, [req.user.userId]);
    res.json({ orders: result.rows.map(toOrderDto) });
  } catch (err) {
    console.error("[orders customer list]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

router.get("/business", async (req, res) => {
  try {
    const result = await pool.query(`${ORDER_SELECT} WHERE b.user_id=$1 ORDER BY o.created_at DESC`, [req.user.userId]);
    res.json({ orders: result.rows.map(toOrderDto) });
  } catch (err) {
    console.error("[orders business list]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(`${ORDER_SELECT} WHERE o.id=$1 AND (o.customer_id=$2 OR b.user_id=$2)`, [req.params.id, req.user.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: "Order not found." });
    res.json({ order: toOrderDto(result.rows[0]) });
  } catch (err) {
    console.error("[orders detail]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

router.patch("/:id/status", async (req, res) => {
  const { status } = req.body;
  if (typeof status !== "string") return res.status(400).json({ error: "status is required." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(`${ORDER_SELECT} WHERE o.id=$1 AND b.user_id=$2 FOR UPDATE OF o`, [req.params.id, req.user.userId]);
    const current = currentResult.rows[0];
    if (!current) throw Object.assign(new Error("Order not found or not owned by your business."), { status: 404 });
    if (!canBusinessTransition(current.status, status, current.fulfillment_type)) {
      throw Object.assign(new Error(`Order cannot move from ${current.status} to ${status}.`), { status: 409 });
    }
    await client.query(
      `UPDATE orders SET status=$1, updated_at=NOW(),
         cancelled_at=CASE WHEN $1='cancelled' THEN NOW() ELSE cancelled_at END,
         cancellation_reason=CASE WHEN $1='cancelled' THEN 'Cancelled by business' ELSE cancellation_reason END
       WHERE id=$2`,
      [status, req.params.id]
    );
    await client.query(
      `UPDATE messages SET text=regexp_replace(text, '\\|[^|]*$', '|' || $1)
       WHERE client_message_id=$2`,
      [status, `order:${req.params.id}`]
    );
    const updated = await client.query(`${ORDER_SELECT} WHERE o.id=$1`, [req.params.id]);
    await client.query("COMMIT");
    emitOrderUpdate(req, updated.rows[0]);
    res.json({ success: true, order: toOrderDto(updated.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[orders status]", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Server error." });
  } finally {
    client.release();
  }
});

// Pickup/in-store/courier orders are completed by the customer. The
// business can mark them ready, but cannot claim that collection happened.
router.patch("/:id/collect", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      `${ORDER_SELECT} WHERE o.id=$1 AND o.customer_id=$2 FOR UPDATE OF o`,
      [req.params.id, req.user.userId]
    );
    const current = currentResult.rows[0];
    if (!current) throw Object.assign(new Error("Order not found."), { status: 404 });
    if (!CUSTOMER_COLLECTION_MODES.has(current.fulfillment_type)) {
      throw Object.assign(new Error("This order does not use customer collection."), { status: 409 });
    }
    if (current.status !== "ready") {
      throw Object.assign(new Error("The business must mark this order ready before collection can be confirmed."), { status: 409 });
    }
    await client.query(
      "UPDATE orders SET status='collected', collected_at=NOW(), updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    await client.query(
      `UPDATE messages SET text=regexp_replace(text, '\\|[^|]*$', '|collected') WHERE client_message_id=$1`,
      [`order:${req.params.id}`]
    );
    const updated = await client.query(`${ORDER_SELECT} WHERE o.id=$1`, [req.params.id]);
    await client.query("COMMIT");
    emitOrderUpdate(req, updated.rows[0]);
    res.json({ success: true, order: toOrderDto(updated.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[orders collect]", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Server error." });
  } finally {
    client.release();
  }
});

router.patch("/:id/cancel", async (req, res) => {
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(`${ORDER_SELECT} WHERE o.id=$1 AND o.customer_id=$2 FOR UPDATE OF o`, [req.params.id, req.user.userId]);
    const current = currentResult.rows[0];
    if (!current) throw Object.assign(new Error("Order not found."), { status: 404 });
    if (!["pending", "confirmed"].includes(current.status)) {
      throw Object.assign(new Error("This order can no longer be cancelled by the customer."), { status: 409 });
    }
    await client.query(
      `UPDATE orders SET status='cancelled', updated_at=NOW(), cancelled_at=NOW(), cancellation_reason=$1 WHERE id=$2`,
      [reason || "Cancelled by customer", req.params.id]
    );
    await client.query(
      `UPDATE messages SET text=regexp_replace(text, '\\|[^|]*$', '|cancelled')
       WHERE client_message_id=$1`,
      [`order:${req.params.id}`]
    );
    const updated = await client.query(`${ORDER_SELECT} WHERE o.id=$1`, [req.params.id]);
    await client.query("COMMIT");
    emitOrderUpdate(req, updated.rows[0]);
    res.json({ success: true, order: toOrderDto(updated.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[orders cancel]", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Server error." });
  } finally {
    client.release();
  }
});

module.exports = router;
