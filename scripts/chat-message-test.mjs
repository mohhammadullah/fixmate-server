/**
 * FixMate chat message delivery test (development only).
 *
 * Reproduces the production report end-to-end against a real Socket.IO
 * server: a customer sends a message; the assigned technician's socket —
 * joined to BOTH the booking room and their user room, exactly like an open
 * ChatPanel — receives both `chat:message` emissions. Verifies:
 *   - the booking room delivers the bare message DTO;
 *   - the user room delivers the `{ bookingId, message }` envelope;
 *   - the bare DTO has the full shape the receiver's UI renders
 *     (parseable createdAt — new Date() must be valid, or the render path
 *     throws);
 *   - the envelope is NOT a renderable message but unwraps to one that is;
 *   - the sender (customer) receives the bare DTO in the booking room;
 *   - REST transcript/unread/read flow works for the receiver.
 *
 * Throwaway accounts/bookings are cleaned up. No shared data is mutated.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env) plus a BASE_URL of a
 * running server that mounts the Socket.IO layer (use
 * scripts/with-isolated-app.mjs, which attaches it).
 * Usage: node scripts/with-isolated-app.mjs scripts/chat-message-test.mjs
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { io } from "socket.io-client";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const TEST_ORIGIN = process.env.TEST_ORIGIN ?? "http://localhost:3000";

if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) {
  console.error("MONGODB_URI and MONGODB_DB_NAME must be set (via .env).");
  process.exit(1);
}

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual", ...options });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const jsonHeaders = (token) => ({
  "content-type": "application/json",
  origin: TEST_ORIGIN,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const signUp = async (email, name, password) => {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: TEST_ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`signup failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
};

const signInAndGetToken = async (email, password) => {
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: TEST_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) throw new Error(`signin failed ${signin.status}`);
  const cookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
  const tokenRes = await api("/api/auth/token", { headers: { cookie } });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`could not obtain JWT (status ${tokenRes.status})`);
  }
  return tokenRes.body.token;
};

const waitForEvent = (socket, event, timeoutMs = 4000, filter = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!filter(payload)) return; // keep waiting
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

const connectSocket = (token) =>
  new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      path: "/socket.io",
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("socket connect timeout"));
    }, 5000);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error(`socket connect_error: ${error.message}`));
    });
  });

const main = async () => {
  console.log(`Chat message delivery test against ${BASE_URL}\n`);

  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const bookings = db.collection("bookings");

  const stamp = Date.now();
  const customerEmail = `fixmate.chatmsg.customer.${stamp}@example.com`;
  const technicianEmail = `fixmate.chatmsg.technician.${stamp}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";

  // Sign up both accounts first, promote the technician BEFORE minting JWTs —
  // the DB is the role authority either way.
  await signUp(customerEmail, "ChatMsg Customer", password);
  await signUp(technicianEmail, "ChatMsg Technician", password);
  await users.updateOne({ email: technicianEmail }, { $set: { role: "technician" } });

  const technician = await users.findOne({ email: technicianEmail });
  const customer = await users.findOne({ email: customerEmail });

  const technicianToken = await signInAndGetToken(technicianEmail, password);
  const customerToken = await signInAndGetToken(customerEmail, password);

  const bookingId = new ObjectId();
  const now = new Date();
  await bookings.insertOne({
    _id: bookingId,
    serviceId: new ObjectId(),
    customerId: customer._id,
    technicianId: technician._id,
    customerName: "ChatMsg Customer",
    customerEmail,
    technicianName: "ChatMsg Technician",
    technicianEmail,
    serviceTitle: "Seeded Repair Job",
    serviceCategory: "AC Repair",
    serviceLocation: "Seeded Location",
    serviceImage: "https://example.com/seeded.jpg",
    hourlyRate: 45,
    securityDeposit: 50,
    problemDescription: "Chat delivery test booking.",
    status: "in_progress",
    paymentStatus: "unpaid",
    createdAt: now,
    updatedAt: now,
  });

  let technicianSocket = null;
  let customerSocket = null;
  try {
    technicianSocket = await connectSocket(technicianToken);
    const joinAck = await new Promise((resolve) => {
      technicianSocket.emit("join:booking", { bookingId: bookingId.toHexString() }, resolve);
    });
    check(joinAck?.success === true, `technician joins booking room (ack: ${JSON.stringify(joinAck)})`);

    customerSocket = await connectSocket(customerToken);
    const customerJoinAck = await new Promise((resolve) => {
      customerSocket.emit("join:booking", { bookingId: bookingId.toHexString() }, resolve);
    });
    check(customerJoinAck?.success === true, `customer joins booking room (ack: ${JSON.stringify(customerJoinAck)})`);

    // Register collectors BEFORE the send so no event is missed.
    const bookingRoomEvent = waitForEvent(
      technicianSocket,
      "chat:message",
      4000,
      (payload) => payload && typeof payload === "object" && typeof payload.id === "string"
    );
    const userRoomEvent = waitForEvent(
      technicianSocket,
      "chat:message",
      4000,
      (payload) =>
        payload &&
        typeof payload === "object" &&
        "message" in payload &&
        payload.bookingId === bookingId.toHexString()
    );
    const customerRoomEvent = waitForEvent(
      customerSocket,
      "chat:message",
      4000,
      (payload) => payload && typeof payload === "object" && typeof payload.id === "string"
    );

    const send = await api(`/api/bookings/${bookingId.toHexString()}/chat`, {
      method: "POST",
      headers: jsonHeaders(customerToken),
      body: JSON.stringify({ text: "Hello from the customer — parts arrived today." }),
    });
    check(send.status === 201, `customer sends message -> ${send.status} (expected 201)`);

    const [bookingRoomPayload, userRoomPayload, customerRoomPayload] = await Promise.all([
      bookingRoomEvent,
      userRoomEvent,
      customerRoomEvent,
    ]);

    // --- Booking room delivers the bare DTO --------------------------------
    console.log("\n[booking room payload]");
    const bare = bookingRoomPayload;
    check(typeof bare.id === "string" && bare.id.length > 0, "bare DTO carries a message id");
    check(typeof bare.senderId === "string" && bare.senderId === customer._id.toHexString(), "bare DTO senderId is the customer");
    check(bare.senderRole === "customer", "bare DTO senderRole is customer");
    check(typeof bare.text === "string" && bare.text.includes("parts arrived"), "bare DTO carries the text");
    check(!Number.isNaN(Date.parse(bare.createdAt ?? "")), "bare DTO createdAt parses (render-safe)");
    let renderThrew = false;
    try {
      // The exact expression the render path uses — must not throw.
      new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(bare.createdAt));
    } catch {
      renderThrew = true;
    }
    check(!renderThrew, "bare DTO renders through Intl.DateTimeFormat without throwing");

    // --- User room delivers the envelope ------------------------------------
    console.log("\n[user room envelope]");
    const envelope = userRoomPayload;
    check(envelope.bookingId === bookingId.toHexString(), "envelope bookingId matches this booking");
    check(typeof envelope.message?.id === "string" && envelope.message.id === bare.id, "envelope unwraps to the same message");
    check(typeof envelope.id === "undefined", "envelope itself is NOT a renderable message (no top-level id)");
    check(
      !Number.isNaN(Date.parse(envelope.message?.createdAt ?? "")),
      "envelope's inner message createdAt parses (render-safe once unwrapped)"
    );

    // --- Customer receives the same bare DTO ---------------------------------
    console.log("\n[sender room payload]");
    check(customerRoomPayload.id === bare.id, "customer sees their own message in the booking room");

    // --- Transcript state via REST -------------------------------------------
    console.log("\n[transcript]");
    const list = await api(`/api/bookings/${bookingId.toHexString()}/chat?limit=10`, {
      headers: jsonHeaders(technicianToken),
    });
    check(list.status === 200 && Array.isArray(list.body?.data) && list.body.data.some((m) => m.id === bare.id), "technician's transcript contains the message");
    check(list.body?.unreadCount === 1, `technician has 1 unread message (got ${list.body?.unreadCount})`);
    const read = await api(`/api/bookings/${bookingId.toHexString()}/chat/read`, {
      method: "POST",
      headers: jsonHeaders(technicianToken),
    });
    check(read.status === 200, `technician marks read -> ${read.status}`);
    const listAfter = await api(`/api/bookings/${bookingId.toHexString()}/chat?limit=10`, {
      headers: jsonHeaders(technicianToken),
    });
    check(listAfter.body?.unreadCount === 0, `unread cleared after read -> ${listAfter.body?.unreadCount}`);
  } finally {
    technicianSocket?.disconnect();
    customerSocket?.disconnect();
    await bookings.deleteOne({ _id: bookingId });
    await users.deleteMany({ _id: { $in: [customer._id, technician._id] } });
    await db.collection("session").deleteMany({ userId: { $in: [customer._id.toHexString(), technician._id.toHexString()] } });
    await db.collection("account").deleteMany({ userId: { $in: [customer._id.toHexString(), technician._id.toHexString()] } });
    await client.close();
    console.log("\ncleanup: seeded booking and throwaway users removed, sockets disconnected");
  }

  console.log(`\n${failures === 0 ? "CHAT MESSAGE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("chat-message test crashed:", error);
  process.exit(1);
});
