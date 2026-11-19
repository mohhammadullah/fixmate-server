/**
 * FixMate chat read-receipt test (development only).
 *
 * Exercises POST /api/bookings/:id/chat/read against:
 *  - bookings with no `conversation` object (legacy)
 *  - a `conversation` object with no `messages` field
 *  - an empty `messages` array
 *  - unread messages from the other participant
 *  - already-read messages
 *  - messages sent by the reader themselves
 *  - unauthorized callers
 *
 * Also checks idempotency (repeated reads change nothing) and that the
 * related send path works on legacy bookings without losing conversation
 * metadata. Throwaway users/bookings are cleaned up afterwards.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/with-isolated-app.mjs scripts/chat-read-test.mjs
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const TEST_ORIGIN = process.env.TEST_ORIGIN ?? "http://localhost:3000";

if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) {
  console.error("MONGODB_URI and MONGODB_DB_NAME must be set (via .env).");
  process.exit(1);
}

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));
const deepCheck = (actual, expected, msg) => {
  try {
    assert.deepStrictEqual(actual, expected);
    pass(msg);
  } catch (error) {
    fail(`${msg} (${error.message})`);
  }
};

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual", ...options });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
};

const jsonHeaders = (token) => ({
  "content-type": "application/json",
  origin: TEST_ORIGIN,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const readEndpoint = (bookingId, token) =>
  api(`/api/bookings/${bookingId.toHexString()}/chat/read`, {
    method: "POST",
    headers: token ? jsonHeaders(token) : {},
  });

const sendEndpoint = (bookingId, token, text) =>
  api(`/api/bookings/${bookingId.toHexString()}/chat`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ text }),
  });

const getJwt = async (sessionCookie) => {
  const tokenRes = await api("/api/auth/token", {
    headers: { cookie: sessionCookie },
  });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`could not obtain JWT (status ${tokenRes.status})`);
  }
  return tokenRes.body.token;
};

const signUpAndSignIn = async (email, name, password) => {
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password, name }),
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`signup failed ${signup.status}: ${JSON.stringify(signup.body)}`);
  }
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) {
    throw new Error(`signin failed ${signin.status}: ${JSON.stringify(signin.body)}`);
  }
  const setCookie = signin.headers?.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.includes("session_token"))?.split(";")[0];
  if (!sessionCookie) throw new Error("no session cookie from signin");
  return { token: await getJwt(sessionCookie) };
};

const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
});

const main = async () => {
  console.log(`Chat-read test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const bookings = db.collection("bookings");

  const runId = Date.now();
  const emails = [
    `fixmate.chatread.customer.${runId}@example.com`,
    `fixmate.chatread.tech.${runId}@example.com`,
    `fixmate.chatread.outsider.${runId}@example.com`,
  ];
  const password = `ChatRead-${runId}-Aa1!`;
  const seededBookingIds = [];

  try {
    console.log("[setup]");
    const customer = {
      email: emails[0],
      ...(await signUpAndSignIn(emails[0], "Chat Read Customer", password)),
      user: await users.findOne({ email: emails[0] }),
    };
    const technician = {
      email: emails[1],
      ...(await signUpAndSignIn(emails[1], "Chat Read Technician", password)),
      user: await users.findOne({ email: emails[1] }),
    };
    const outsider = {
      email: emails[2],
      ...(await signUpAndSignIn(emails[2], "Chat Read Outsider", password)),
      user: await users.findOne({ email: emails[2] }),
    };
    if (!customer.user || !technician.user || !outsider.user) {
      throw new Error("failed to seed test users");
    }
    await users.updateOne({ _id: technician.user._id }, { $set: { role: "technician" } });

    const now = new Date();
    const seedBooking = async (extra = {}) => {
      const _id = new ObjectId();
      const doc = {
        _id,
        serviceId: new ObjectId(),
        customerId: customer.user._id,
        technicianId: technician.user._id,
        customerName: "Chat Read Customer",
        customerEmail: emails[0],
        technicianName: "Chat Read Technician",
        technicianEmail: emails[1],
        serviceTitle: "Chat Read Test Service",
        serviceCategory: "AC Repair",
        serviceLocation: "Khulna",
        serviceImage: "https://example.com/chat-read.jpg",
        hourlyRate: 50,
        securityDeposit: 25,
        problemDescription: "Seeded booking for the chat read-receipt test.",
        status: "accepted",
        paymentStatus: "unpaid",
        createdAt: now,
        updatedAt: now,
      };
      // Skip undefined values so `conversation` stays truly absent.
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) doc[key] = value;
      }
      await bookings.insertOne(doc);
      seededBookingIds.push(_id);
      return _id;
    };

    const message = (senderId, senderRole, text, readAt) => {
      const msg = {
        id: new ObjectId().toHexString(),
        senderId,
        senderRole,
        text,
        createdAt: new Date(),
      };
      if (readAt !== undefined) msg.readAt = readAt;
      return msg;
    };

    // 1. Legacy booking: no `conversation` object at all.
    console.log("\n[no conversation object]");
    const noConversation = await seedBooking();
    const preLegacy = await bookings.findOne({ _id: noConversation });
    check(!Object.hasOwn(preLegacy, "conversation"), "legacy booking has no conversation field");
    const legacyRead = await readEndpoint(noConversation, technician.token);
    check(
      legacyRead.status === 200 && legacyRead.body?.success === true,
      `read on booking without conversation -> ${legacyRead.status} ${JSON.stringify(legacyRead.body)}`
    );
    const postLegacy = await bookings.findOne({ _id: noConversation });
    check(
      !Object.hasOwn(postLegacy, "conversation"),
      "read did not create a conversation object on a legacy booking"
    );

    // 2. Conversation exists but `messages` is missing.
    console.log("\n[conversation without messages array]");
    const noMessages = await seedBooking({ conversation: { note: "preserve-me" } });
    const noMessagesRead = await readEndpoint(noMessages, technician.token);
    check(
      noMessagesRead.status === 200 && noMessagesRead.body?.success === true,
      `read on conversation without messages -> ${noMessagesRead.status}`
    );
    const postNoMessages = await bookings.findOne({ _id: noMessages });
    deepCheck(postNoMessages.conversation, { note: "preserve-me" }, "conversation metadata preserved");

    // 3. Empty messages array.
    console.log("\n[empty messages array]");
    const emptyMessages = await seedBooking({ conversation: { messages: [] } });
    const emptyRead = await readEndpoint(emptyMessages, technician.token);
    check(emptyRead.status === 200, `read on empty messages -> ${emptyRead.status}`);
    deepCheck(
      (await bookings.findOne({ _id: emptyMessages })).conversation,
      { messages: [] },
      "empty messages array unchanged"
    );

    // 4. Unread / read / own messages mixed together.
    console.log("\n[unread and already-read messages]");
    const previouslyReadAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const mixed = await seedBooking({
      conversation: {
        messages: [
          message(customer.user._id, "customer", "unread explicit null", null),
          message(customer.user._id, "customer", "unread missing readAt"),
          message(technician.user._id, "technician", "technician's own unread", null),
          message(customer.user._id, "customer", "already read", previouslyReadAt),
        ],
      },
    });
    const mixedRead = await readEndpoint(mixed, technician.token);
    check(mixedRead.status === 200, `technician marks customer messages read -> ${mixedRead.status}`);
    const afterMixed = (await bookings.findOne({ _id: mixed })).conversation.messages;
    check(
      afterMixed[0].readAt instanceof Date && afterMixed[1].readAt instanceof Date,
      "unread messages from the other participant are marked read"
    );
    check(afterMixed[2].readAt === null, "reader's own message stays unread");
    check(
      afterMixed[3].readAt instanceof Date && afterMixed[3].readAt.getTime() === previouslyReadAt.getTime(),
      "already-read message timestamp preserved"
    );

    const snapshot = afterMixed.map((m) => m.readAt?.toISOString() ?? null);
    const repeatRead = await readEndpoint(mixed, technician.token);
    check(repeatRead.status === 200, `repeat read -> ${repeatRead.status}`);
    deepCheck(
      (await bookings.findOne({ _id: mixed })).conversation.messages.map((m) => m.readAt?.toISOString() ?? null),
      snapshot,
      "repeat read is idempotent (no readAt changes)"
    );

    const listAsTechnician = await api(`/api/bookings/${mixed.toHexString()}/chat`, {
      headers: { authorization: `Bearer ${technician.token}` },
    });
    check(
      listAsTechnician.status === 200 && listAsTechnician.body?.unreadCount === 0,
      `technician unread count is zero -> ${listAsTechnician.body?.unreadCount}`
    );
    const listAsCustomer = await api(`/api/bookings/${mixed.toHexString()}/chat`, {
      headers: { authorization: `Bearer ${customer.token}` },
    });
    check(
      listAsCustomer.status === 200 && listAsCustomer.body?.unreadCount === 1,
      `customer still has one unread (technician's message) -> ${listAsCustomer.body?.unreadCount}`
    );

    // Customer reads in the other direction.
    const customerRead = await readEndpoint(mixed, customer.token);
    check(customerRead.status === 200, `customer marks technician message read -> ${customerRead.status}`);
    const afterCustomerRead = (await bookings.findOne({ _id: mixed })).conversation.messages;
    check(
      afterCustomerRead[2].readAt instanceof Date,
      "technician's message was marked read by the customer"
    );
    check(
      afterCustomerRead[0].readAt.getTime() === afterMixed[0].readAt.getTime() &&
        afterCustomerRead[1].readAt.getTime() === afterMixed[1].readAt.getTime(),
      "customer's own messages were not re-marked"
    );

    // 5. Only the reader's own messages exist.
    console.log("\n[only own messages]");
    const ownOnly = await seedBooking({
      conversation: { messages: [message(technician.user._id, "technician", "my own note", null)] },
    });
    const ownRead = await readEndpoint(ownOnly, technician.token);
    check(ownRead.status === 200, `read with only own messages -> ${ownRead.status}`);
    deepCheck(
      (await bookings.findOne({ _id: ownOnly })).conversation.messages.map((m) => m.readAt ?? null),
      [null],
      "own-only message left untouched"
    );

    // 6. Authorization.
    console.log("\n[authorization]");
    const foreignRead = await readEndpoint(mixed, outsider.token);
    check(foreignRead.status === 404, `outsider cannot mark conversation read -> ${foreignRead.status}`);
    const unauthenticated = await api(`/api/bookings/${mixed.toHexString()}/chat/read`, {
      method: "POST",
    });
    check(unauthenticated.status === 401, `read requires authentication -> ${unauthenticated.status}`);

    // 7. Send path on legacy bookings, then read the new message.
    console.log("\n[send + read on legacy bookings]");
    const sendLegacy = await sendEndpoint(
      noConversation,
      customer.token,
      "Hello from a legacy booking."
    );
    check(sendLegacy.status === 201, `send on booking without conversation -> ${sendLegacy.status}`);
    const afterLegacySend = await bookings.findOne({ _id: noConversation });
    check(
      Array.isArray(afterLegacySend.conversation?.messages) &&
        afterLegacySend.conversation.messages.length === 1,
      "send initialized conversation.messages on a legacy booking"
    );
    const readNewMessage = await readEndpoint(noConversation, technician.token);
    check(readNewMessage.status === 200, `read newly sent message -> ${readNewMessage.status}`);
    check(
      (await bookings.findOne({ _id: noConversation })).conversation.messages[0].readAt instanceof Date,
      "newly sent message marked read"
    );

    const sendWithMetadata = await sendEndpoint(noMessages, customer.token, "Metadata must survive.");
    check(sendWithMetadata.status === 201, `send with existing conversation -> ${sendWithMetadata.status}`);
    const afterMetaSend = await bookings.findOne({ _id: noMessages });
    check(
      afterMetaSend.conversation.note === "preserve-me" &&
        afterMetaSend.conversation.messages?.length === 1,
      "send preserved existing conversation metadata"
    );
  } finally {
    console.log("\n[cleanup]");
    await bookings.deleteMany({ _id: { $in: seededBookingIds } });
    for (const email of emails) {
      const user = await users.findOne({ email });
      if (user) {
        await sessions.deleteMany({ userId: user._id });
        await accounts.deleteMany({ userId: user._id });
        await users.deleteOne({ _id: user._id });
      }
    }
    await client.close();
    console.log("  cleanup done");
  }

  console.log(`\n${failures === 0 ? "CHAT READ CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("chat-read test crashed:", error);
  process.exit(1);
});
