/**
 * FixMate — features 1–10 integration test (development only).
 *
 * Covers: technician availability, appointment scheduling + conflict
 * prevention, timeline, notifications, chat, invoices, refunds (mocked
 * Stripe), coupons, nearby services, admin analytics, admin booking view.
 *
 * Self-contained: boots its own API copy on an ephemeral port with a mock
 * Stripe HTTP API. Seeds throwaway users/service/bookings directly in
 * MongoDB and cleans up afterwards.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: TEST_ORIGIN.
 * Usage: node scripts/features-test.mjs
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { MongoClient, ObjectId } from "mongodb";

process.env.STRIPE_SECRET_KEY = "sk_test_mock_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock_test_secret_0123456789";
process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";
delete process.env.STRIPE_API_BASE;
delete process.env.BETTER_AUTH_URL;

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const TEST_ORIGIN = process.env.TEST_ORIGIN ?? "http://localhost:3000";
const jsonHeaders = (origin = TEST_ORIGIN) => ({
  "content-type": "application/json",
  origin,
});

const api = async (base, path, options = {}) => {
  const res = await fetch(`${base}${path}`, { redirect: "manual", ...options });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
};

const getJwt = async (base, sessionCookie) => {
  const tokenRes = await api(base, "/api/auth/token", {
    headers: { cookie: sessionCookie },
  });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`could not obtain JWT (status ${tokenRes.status})`);
  }
  return tokenRes.body.token;
};

const signUpAndSignIn = async (base, email, password, name) => {
  const signup = await api(base, "/api/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password, name }),
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`signup failed ${signup.status}: ${JSON.stringify(signup.body)}`);
  }
  const signin = await api(base, "/api/auth/sign-in/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  const setCookie = signin.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.includes("session_token"))?.split(";")[0];
  if (!sessionCookie) throw new Error("no session cookie from signin");
  return sessionCookie;
};

// A weekday (Mon-Sat) at least `daysAhead` in the future, YYYY-MM-DD.
const futureWeekday = (daysAhead) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  while (d.getUTCDay() === 0) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
};

const main = async () => {
  const appPort = await getFreePort();
  const mockPort = await getFreePort();
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${appPort}`;

  const APP_BASE = `http://127.0.0.1:${appPort}`;
  console.log(`Features test (API on :${appPort}, mock Stripe on :${mockPort})\n`);

  // --- Mock Stripe API ---
  let checkoutCalls = 0;
  let refundCalls = 0;
  const mockStripe = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock");

      if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        checkoutCalls += 1;
        const params = new URLSearchParams(body);
        const unitAmount = Number(params.get("line_items[0][price_data][unit_amount]"));
        const currency = (params.get("currency") ?? "usd").toLowerCase();
        const id = `cs_test_mock_${checkoutCalls}`;
        const metadata = {};
        for (const key of ["bookingId", "customerId"]) {
          const value = params.get(`metadata[${key}]`);
          if (value) metadata[key] = value;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id,
          object: "checkout.session",
          status: "open",
          mode: "payment",
          amount_total: unitAmount,
          currency,
          url: `https://checkout.stripe.test/pay/${id}`,
          expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
          payment_status: "unpaid",
          metadata,
          client_reference_id: params.get("client_reference_id"),
          success_url: params.get("success_url"),
          cancel_url: params.get("cancel_url"),
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/refunds") {
        refundCalls += 1;
        const params = new URLSearchParams(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `re_mock_${refundCalls}`,
          object: "refund",
          amount: Number(params.get("amount")),
          payment_intent: params.get("payment_intent"),
          status: "succeeded",
        }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve, reject) => {
    mockStripe.once("error", reject);
    mockStripe.listen(mockPort, "127.0.0.1", resolve);
  });

  const { connectDB, closeDB } = await import("../dist/config/db.js");
  const { ensureIndexes } = await import("../dist/config/indexes.js");
  const { createAuth } = await import("../dist/config/auth.js");
  const { createApp } = await import("../dist/app.js");

  await connectDB();
  await ensureIndexes();

  const app = createApp(createAuth());
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(appPort, "127.0.0.1", resolve);
  });

  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const bookings = db.collection("bookings");
  const services = db.collection("services");
  const payments = db.collection("payments");

  const runId = Date.now();
  const EMAIL_A = `fixmate.feat.a.${runId}@example.com`;
  const EMAIL_B = `fixmate.feat.b.${runId}@example.com`;
  const EMAIL_C = `fixmate.feat.c.${runId}@example.com`;
  const PASSWORD = `Feat-Test-${runId}-Aa1!`;

  const seededIds = { bookings: [], services: [], payments: [] };
  let userA, userB, userC, technician;

  try {
    // --- Create accounts ---
    console.log("[setup]");
    const cookieA = await signUpAndSignIn(APP_BASE, EMAIL_A, PASSWORD, "Feat Customer A");
    const cookieB = await signUpAndSignIn(APP_BASE, EMAIL_B, PASSWORD, "Feat Customer B");
    const cookieC = await signUpAndSignIn(APP_BASE, EMAIL_C, PASSWORD, "Feat Outsider C");
    userA = await users.findOne({ email: EMAIL_A });
    userB = await users.findOne({ email: EMAIL_B });
    userC = await users.findOne({ email: EMAIL_C });

    // Technician: reuse account B's user, flip role to technician.
    await users.updateOne({ _id: userB._id }, { $set: { role: "technician" } });
    technician = await users.findOne({ _id: userB._id });
    const cookieT = cookieB;

    // --- Seed an approved service by the technician ---
    const now = new Date();
    const serviceId = new ObjectId();
    await services.insertOne({
      _id: serviceId,
      title: `Feat Test Service ${runId}`,
      category: "AC Repair",
      description: "Seeded service for the feature integration test.",
      overview: "Seeded overview for the feature integration test.",
      hourlyRate: 50,
      securityDeposit: 25,
      maxCapacity: 3,
      location: "Khulna",
      image: "https://example.com/feat.jpg",
      amenities: ["Seeded amenity"],
      technicianId: userB._id,
      technicianName: "Feat Customer B",
      technicianEmail: EMAIL_B,
      approvalStatus: "approved",
      availabilityStatus: "available",
      createdAt: now,
      updatedAt: now,
    });
    seededIds.services.push(serviceId);
    console.log("  seeded service", serviceId.toHexString());

    const tokenA = await getJwt(APP_BASE, cookieA);
    const tokenT = await getJwt(APP_BASE, cookieT);
    const tokenC = await getJwt(APP_BASE, cookieC);
    const authA = { headers: { authorization: `Bearer ${tokenA}` } };
    const authT = { headers: { authorization: `Bearer ${tokenT}` } };
    const authC = { headers: { authorization: `Bearer ${tokenC}` } };

    // ============ FEATURE 1: availability ============
    console.log("\n[availability]");
    const availGet = await api(APP_BASE, "/api/users/me/availability", authT);
    check(availGet.status === 200 && availGet.body?.data?.status === "available", `technician availability defaults available -> ${availGet.status}`);

    const availBadWeekly = await api(APP_BASE, "/api/users/me/availability", {
      method: "PUT",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenT}` },
      body: JSON.stringify({ status: "available", weekly: [{ day: 1, enabled: true, start: "09:00", end: "18:00", breaks: [] }], unavailableDates: [], serviceAreas: ["Khulna"], timezone: "Asia/Dhaka" }),
    });
    check(availBadWeekly.status === 400, `weekly must contain 7 days -> ${availBadWeekly.status}`);

    const availBadTz = await api(APP_BASE, "/api/users/me/availability", {
      method: "PUT",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenT}` },
      body: JSON.stringify({ status: "available", weekly: Array.from({ length: 7 }, (_, d) => ({ day: d, enabled: true, start: "09:00", end: "18:00", breaks: [] })), unavailableDates: [], serviceAreas: [], timezone: "Not/AZone" }),
    });
    check(availBadTz.status === 400, `invalid timezone rejected -> ${availBadTz.status}`);

    const availEndBeforeStart = await api(APP_BASE, "/api/users/me/availability", {
      method: "PUT",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenT}` },
      body: JSON.stringify({ status: "available", weekly: Array.from({ length: 7 }, (_, d) => ({ day: d, enabled: true, start: "18:00", end: "09:00", breaks: [] })), unavailableDates: [], serviceAreas: [], timezone: "Asia/Dhaka" }),
    });
    check(availEndBeforeStart.status === 400, `start<end enforced -> ${availEndBeforeStart.status}`);

    const unavailDate = futureWeekday(9);
    const availPut = await api(APP_BASE, "/api/users/me/availability", {
      method: "PUT",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenT}` },
      body: JSON.stringify({
        status: "available",
        weekly: Array.from({ length: 7 }, (_, d) => ({ day: d, enabled: d !== 0, start: "09:00", end: "18:00", breaks: [{ start: "13:00", end: "14:00" }] })),
        unavailableDates: [unavailDate],
        serviceAreas: ["Khulna"],
        timezone: "Asia/Dhaka",
      }),
    });
    check(availPut.status === 200 && availPut.body?.data?.unavailableDates?.includes(unavailDate), `availability saved -> ${availPut.status}`);

    const availCustomer = await api(APP_BASE, "/api/users/me/availability", authA);
    check(availCustomer.status === 403, `customer cannot PUT/GET technician availability (GET as customer -> 403) -> ${availCustomer.status}`);

    // ============ FEATURE 2: scheduling ============
    console.log("\n[scheduling]");
    const slotDate = futureWeekday(7); // ~7 days ahead, Mon-Sat
    const pastRes = await api(APP_BASE, "/api/bookings", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        serviceId: serviceId.toHexString(),
        problemDescription: "The AC is not cooling at all and the filter smells burnt.",
        schedule: { date: "2020-01-01", slotStart: "10:00", timezone: "Asia/Dhaka" },
      }),
    });
    check(pastRes.status === 400, `past slot rejected -> ${pastRes.status}`);

    const badTz = await api(APP_BASE, "/api/bookings", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        serviceId: serviceId.toHexString(),
        problemDescription: "The AC is not cooling at all and the filter smells burnt.",
        schedule: { date: slotDate, slotStart: "10:00", timezone: "Not/AZone" },
      }),
    });
    check(badTz.status === 400, `invalid schedule timezone rejected -> ${badTz.status}`);

    const earlySlot = await api(APP_BASE, "/api/bookings", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        serviceId: serviceId.toHexString(),
        problemDescription: "The AC is not cooling at all and the filter smells burnt.",
        schedule: { date: slotDate, slotStart: "06:00", timezone: "Asia/Dhaka" },
      }),
    });
    check(earlySlot.status === 409, `slot outside working hours rejected -> ${earlySlot.status}`);

    // Unavailable date must 409.
    await users.updateOne({ _id: userB._id }, { $set: { "availability.unavailableDates": [slotDate] } });
    const unavailableSlot = await api(APP_BASE, "/api/bookings", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        serviceId: serviceId.toHexString(),
        problemDescription: "The AC is not cooling at all and the filter smells burnt.",
        schedule: { date: slotDate, slotStart: "10:00", timezone: "Asia/Dhaka" },
      }),
    });
    check(unavailableSlot.status === 409, `unavailable date rejected -> ${unavailableSlot.status}`);
    await users.updateOne({ _id: userB._id }, { $set: { "availability.unavailableDates": [] } });

    // Valid scheduled booking.
    const validSlot = await api(APP_BASE, "/api/bookings", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        serviceId: serviceId.toHexString(),
        problemDescription: "The AC is not cooling at all and the filter smells burnt.",
        schedule: { date: slotDate, slotStart: "10:00", timezone: "Asia/Dhaka" },
      }),
    });
    check(validSlot.status === 201 && validSlot.body?.data?.schedule?.slotStart === "10:00", `valid scheduled booking -> ${validSlot.status}`);
    const booking1Id = new ObjectId(validSlot.body?.data?._id ?? new ObjectId());
    seededIds.bookings.push(booking1Id);

    // Second customer on the same technician slot -> 409.
    const clash = await api(APP_BASE, "/api/bookings", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenC}` },
      body: JSON.stringify({
        serviceId: serviceId.toHexString(),
        problemDescription: "Also needs the AC looked at, completely different customer.",
        schedule: { date: slotDate, slotStart: "10:00", timezone: "Asia/Dhaka" },
      }),
    });
    check(clash.status === 409, `overlapping slot rejected -> ${clash.status}`);

    // Booking without a schedule still works (backward compat).
    const legacy = await api(APP_BASE, "/api/bookings", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenC}` },
      body: JSON.stringify({
        serviceId: serviceId.toHexString(),
        problemDescription: "Booking without any schedule details should still work fine.",
      }),
    });
    check(legacy.status === 201, `unscheduled booking still accepted -> ${legacy.status}`);
    const legacyId = new ObjectId(legacy.body?.data?._id ?? new ObjectId());
    seededIds.bookings.push(legacyId);

    // Detail shows schedule + timeline.
    const details = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}`, authA);
    check(
      details.status === 200 && details.body?.data?.schedule?.slotStart === "10:00" && Array.isArray(details.body?.data?.timeline),
      `booking details include schedule + timeline -> ${details.status}`
    );
    if (Array.isArray(details.body?.data?.timeline)) {
      check(details.body.data.timeline.some((e) => e.type === "requested"), "timeline contains requested event");
    }

    // ============ FEATURE 3/4: timeline + notifications on accept ============
    console.log("\n[timeline + notifications]");
    const accept = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/accept`, {
      method: "PATCH",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenT}` },
    });
    check(accept.status === 200, `technician accepts -> ${accept.status}`);

    const notifList = await api(APP_BASE, "/api/notifications", authA);
    check(
      notifList.status === 200 && Array.isArray(notifList.body?.data) && notifList.body.data.some((n) => n.type === "booking_accepted"),
      `customer received booking_accepted notification -> ${notifList.status}`
    );
    check(
      (notifList.body?.unreadCount ?? 0) >= 1,
      `unread count >= 1 -> ${notifList.body?.unreadCount}`
    );
    const unreadId = notifList.body?.data?.find((n) => n.type === "booking_accepted" && !n.readAt)?.id;
    if (unreadId) {
      const mark = await api(APP_BASE, `/api/notifications/${unreadId}/read`, { method: "PATCH", headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` } });
      check(mark.status === 200, `mark one read -> ${mark.status}`);
    }
    const markAll = await api(APP_BASE, "/api/notifications/read-all", { method: "POST", headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` } });
    check(markAll.status === 200, `mark all read -> ${markAll.status}`);
    const afterRead = await api(APP_BASE, "/api/notifications/unread-count", authA);
    check(afterRead.body?.data?.unreadCount === 0, `all notifications read -> unreadCount=${afterRead.body?.data?.unreadCount}`);

    // Notification isolation: customer C never sees customer A's notifications.
    const notifC = await api(APP_BASE, "/api/notifications", authC);
    check(
      Array.isArray(notifC.body?.data) && !notifC.body.data.some((n) => n.bookingId === booking1Id.toHexString()),
      "outsider cannot see A's notifications"
    );

    // ============ FEATURE 7: chat ============
    console.log("\n[chat]");
    const sendA = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/chat`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ text: "Hi, the remote control will be there." }),
    });
    check(sendA.status === 201, `customer sends message -> ${sendA.status}`);

    const tooLong = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/chat`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ text: "x".repeat(501) }),
    });
    check(tooLong.status === 400, `501-char message rejected -> ${tooLong.status}`);

    const listT = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/chat`, authT);
    check(listT.status === 200 && listT.body?.data?.length === 1, `technician sees message -> ${listT.status} (${listT.body?.data?.length})`);

    const outsiderChat = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/chat`, authC);
    check(outsiderChat.status === 404, `outsider cannot read conversation -> ${outsiderChat.status}`);
    const outsiderSend = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/chat`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenC}` },
      body: JSON.stringify({ text: "I am not a participant." }),
    });
    check(outsiderSend.status === 404, `outsider cannot send to conversation -> ${outsiderSend.status}`);

    // Admin can read but not send.
    await users.updateOne({ _id: userC._id }, { $set: { role: "admin" } });
    const tokenAdmin = await getJwt(APP_BASE, cookieC);
    const adminRead = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/chat`, { headers: { authorization: `Bearer ${tokenAdmin}` } });
    check(adminRead.status === 200, `admin can read conversation -> ${adminRead.status}`);
    const adminSend = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/chat`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenAdmin}` },
      body: JSON.stringify({ text: "Admin speaking." }),
    });
    check(adminSend.status === 403, `admin cannot send -> ${adminSend.status}`);
    // Restore C's role for later tests.
    await users.updateOne({ _id: userC._id }, { $set: { role: "customer" } });
    const tokenC2 = await getJwt(APP_BASE, cookieC);

    const markRead = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/chat/read`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenT}` },
    });
    check(markRead.status === 200, `technician marks conversation read -> ${markRead.status}`);

    // ============ FEATURES 5/6: invoice + refunds ============
    console.log("\n[invoice + refund]");
    // Move booking to completed with a final amount via the technician flow.
    await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/status`, {
      method: "PATCH",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenT}` },
      body: JSON.stringify({ status: "in-progress" }),
    });
    const complete = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/status`, {
      method: "PATCH",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenT}` },
      body: JSON.stringify({ status: "completed", finalAmount: 120 }),
    });
    check(complete.status === 200, `technician completes -> ${complete.status}`);

    // Simulate a settled Stripe payment via direct DB write (mirrors what
    // the verified webhook does).
    const paymentId = new ObjectId();
    await payments.insertOne({
      _id: paymentId,
      bookingId: booking1Id,
      customerId: userA._id,
      technicianId: userB._id,
      stripeSessionId: `cs_test_seeded_${runId}`,
      stripePaymentIntentId: `pi_mock_${runId}`,
      amount: 12000,
      currency: "usd",
      status: "succeeded",
      createdAt: new Date(),
      updatedAt: new Date(),
      paidAt: new Date(),
    });
    seededIds.payments.push(paymentId);
    await bookings.updateOne({ _id: booking1Id }, { $set: { paymentStatus: "paid", updatedAt: new Date() } });

    const invoice = await api(APP_BASE, `/api/bookings/${booking1Id.toHexString()}/invoice`, authA);
    check(
      invoice.status === 200 && invoice.body?.data?.number?.startsWith("INV-") && invoice.body?.data?.totalAmount === 120,
      `invoice issued (INV-…, total 120, paid) -> ${invoice.status} ${JSON.stringify(invoice.body?.data?.number)}`
    );
    check(invoice.body?.data?.paymentStatus === "paid", `invoice paymentStatus paid -> ${invoice.body?.data?.paymentStatus}`);

    // Customer cannot request a refund from another customer's payment.
    const foreignRefund = await api(APP_BASE, `/api/payments/${paymentId.toHexString()}/refunds`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenC2}` },
      body: JSON.stringify({ reason: "I am not the owner of this payment." }),
    });
    check(foreignRefund.status === 404, `foreign refund rejected -> ${foreignRefund.status}`);

    const refundReq = await api(APP_BASE, `/api/payments/${paymentId.toHexString()}/refunds`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ reason: "The repair did not fix the problem at all." }),
    });
    check(refundReq.status === 201, `customer requests refund -> ${refundReq.status}`);

    const refundDup = await api(APP_BASE, `/api/payments/${paymentId.toHexString()}/refunds`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ reason: "The repair did not fix the problem at all." }),
    });
    check(refundDup.status === 409, `duplicate pending refund rejected -> ${refundDup.status}`);

    // Customer cannot decide refunds.
    const refundId = refundReq.body?.data?.id;
    const customerDecide = await api(APP_BASE, `/api/admin/refunds/${paymentId.toHexString()}/${refundId}/decide`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ decision: "approve" }),
    });
    check(customerDecide.status === 403, `customer cannot decide refunds -> ${customerDecide.status}`);

    // Admin sees pending refund and approves it (mock Stripe).
    await users.updateOne({ _id: userC._id }, { $set: { role: "admin" } });
    const tokenAdmin2 = await getJwt(APP_BASE, cookieC);
    const adminRefundList = await api(APP_BASE, "/api/admin/refunds?status=pending", { headers: { authorization: `Bearer ${tokenAdmin2}` } });
    check(
      adminRefundList.status === 200 && Array.isArray(adminRefundList.body?.data) && adminRefundList.body.data.some((r) => r.id === refundId),
      `admin sees the pending refund -> ${adminRefundList.status}`
    );
    const approve = await api(APP_BASE, `/api/admin/refunds/${paymentId.toHexString()}/${refundId}/decide`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenAdmin2}` },
      body: JSON.stringify({ decision: "approve", note: "Approved after inspection." }),
    });
    check(approve.status === 200 && approve.body?.data?.status === "succeeded", `admin approves refund (mock Stripe) -> ${approve.status}`);

    const bookingAfterRefund = await bookings.findOne({ _id: booking1Id });
    check(bookingAfterRefund?.paymentStatus === "refunded", `booking marked refunded -> ${bookingAfterRefund?.paymentStatus}`);

    // Restore role for later tests.
    await users.updateOne({ _id: userC._id }, { $set: { role: "customer" } });

    // ============ FEATURE 9: coupons ============
    console.log("\n[coupons]");
    // Designate C as Main Admin and create a fixed coupon.
    await users.updateOne({ _id: userC._id }, { $set: { role: "admin", isMainAdmin: true } });
    const tokenAdmin3 = await getJwt(APP_BASE, cookieC);
    const coupon = await api(APP_BASE, "/api/admin/coupons", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenAdmin3}` },
      body: JSON.stringify({
        code: `FEAT${runId.toString(36).toUpperCase()}`,
        kind: "fixed",
        value: 20,
        currency: "usd",
        minBookingAmount: 50,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        startsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        perCustomerLimit: 1,
        globalLimit: 2,
      }),
    });
    check(coupon.status === 201, `main admin creates coupon -> ${coupon.status} ${JSON.stringify(coupon.body)}`);
    const couponCode = coupon.body?.data?.code;

    // Customer without a booking can't use it; seed a completed unpaid booking for A.
    const booking2Id = new ObjectId();
    await bookings.insertOne({
      _id: booking2Id,
      serviceId,
      customerId: userA._id,
      technicianId: userB._id,
      customerName: "Feat Customer A",
      customerEmail: EMAIL_A,
      technicianName: "Feat Customer B",
      technicianEmail: EMAIL_B,
      serviceTitle: `Feat Test Service ${runId}`,
      serviceCategory: "AC Repair",
      serviceLocation: "Khulna",
      serviceImage: "https://example.com/feat.jpg",
      hourlyRate: 50,
      securityDeposit: 25,
      problemDescription: "Second issue for coupon test booking.",
      status: "completed",
      paymentStatus: "unpaid",
      finalAmount: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    seededIds.bookings.push(booking2Id);

    const preview = await api(APP_BASE, "/api/coupons/validate", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ code: couponCode, bookingId: booking2Id.toHexString() }),
    });
    check(
      preview.status === 200 && preview.body?.data?.discountAmount === 20 && preview.body?.data?.totalAmount === 80,
      `coupon preview discount math correct (100 -> 80) -> ${preview.status} ${JSON.stringify(preview.body?.data)}`
    );

    const checkout = await api(APP_BASE, "/api/payments/checkout-session", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ bookingId: booking2Id.toHexString(), couponCode }),
    });
    check(
      checkout.status === 201 && checkout.body?.data?.amount === 80,
      `checkout amount is discounted (80 USD) -> ${checkout.status} amount=${checkout.body?.data?.amount}`
    );

    // Per-customer limit: a second completed booking for A must reject the coupon.
    const booking3Id = new ObjectId();
    await bookings.insertOne({
      _id: booking3Id,
      serviceId,
      customerId: userA._id,
      technicianId: userB._id,
      customerName: "Feat Customer A",
      customerEmail: EMAIL_A,
      technicianName: "Feat Customer B",
      technicianEmail: EMAIL_B,
      serviceTitle: `Feat Test Service ${runId}`,
      serviceCategory: "AC Repair",
      serviceLocation: "Khulna",
      serviceImage: "https://example.com/feat.jpg",
      hourlyRate: 50,
      securityDeposit: 25,
      problemDescription: "Third issue for per-customer coupon limit test.",
      status: "completed",
      paymentStatus: "unpaid",
      finalAmount: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    seededIds.bookings.push(booking3Id);

    // Seed a succeeded coupon payment for booking2 (per-customer limit).
    await payments.insertOne({
      _id: new ObjectId(),
      bookingId: booking2Id,
      customerId: userA._id,
      technicianId: userB._id,
      stripeSessionId: `cs_test_coupon_${runId}`,
      amount: 8000,
      currency: "usd",
      status: "succeeded",
      createdAt: new Date(),
      updatedAt: new Date(),
      paidAt: new Date(),
      appliedCoupon: { code: couponCode, kind: "fixed", value: 20, discountAmount: 20, currency: "usd", appliedAt: new Date() },
    });
    await bookings.updateOne({ _id: booking2Id }, { $set: { paymentStatus: "paid" } });

    const reuse = await api(APP_BASE, "/api/coupons/validate", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ code: couponCode, bookingId: booking3Id.toHexString() }),
    });
    check(reuse.status === 400, `per-customer coupon limit enforced -> ${reuse.status} (${reuse.body?.message})`);

    // Admin analytics access control.
    const analyticsDenied = await api(APP_BASE, "/api/admin/analytics", authA);
    check(analyticsDenied.status === 403, `customer cannot access analytics -> ${analyticsDenied.status}`);
    const analyticsAdmin = await api(APP_BASE, "/api/admin/analytics", { headers: { authorization: `Bearer ${tokenAdmin3}` } });
    check(analyticsAdmin.status === 200 && typeof analyticsAdmin.body?.data?.users?.total === "number", `admin analytics returns KPIs -> ${analyticsAdmin.status}`);
    check(Array.isArray(analyticsAdmin.body?.data?.payments?.byCurrency), `revenue reported per currency (no cross-currency sums)`);

    // Admin booking detail view includes timeline.
    const adminBooking = await api(APP_BASE, `/api/admin/bookings/${booking1Id.toHexString()}`, { headers: { authorization: `Bearer ${tokenAdmin3}` } });
    check(adminBooking.status === 200 && Array.isArray(adminBooking.body?.data?.timeline), `admin booking detail includes timeline -> ${adminBooking.status}`);

    // Nearby services endpoint.
    const nearby = await api(APP_BASE, "/api/services/nearby?area=Khulna");
    check(nearby.status === 200 && Array.isArray(nearby.body?.data), `nearby services by area -> ${nearby.status}`);
    const nearbyCoords = await api(APP_BASE, "/api/services/nearby?lat=22.8456&lng=89.5403");
    check(nearbyCoords.status === 200, `nearby services by coordinates -> ${nearbyCoords.status}`);
    const nearbyBad = await api(APP_BASE, "/api/services/nearby?lat=999");
    check(nearbyBad.status === 400, `invalid coordinates rejected -> ${nearbyBad.status}`);

    // Restore C's role.
    await users.updateOne({ _id: userC._id }, { $set: { role: "customer", isMainAdmin: false } });
  } finally {
    // --- Cleanup ---
    console.log("\n[cleanup]");
    await bookings.deleteMany({ _id: { $in: seededIds.bookings } });
    await payments.deleteMany({ _id: { $in: seededIds.payments } });
    await payments.deleteMany({ bookingId: { $in: seededIds.bookings } });
    await services.deleteMany({ _id: { $in: seededIds.services } });
    for (const email of [EMAIL_A, EMAIL_B, EMAIL_C]) {
      const u = await users.findOne({ email });
      if (u) {
        await sessions.deleteMany({ userId: u._id });
        await accounts.deleteMany({ userId: u._id });
        await users.deleteOne({ _id: u._id });
      }
    }
    console.log("  cleanup done");
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    await closeDB();
    mockStripe.close();
  }

  console.log(`\n${failures === 0 ? "FEATURES CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("features test crashed:", error);
  process.exit(1);
});
