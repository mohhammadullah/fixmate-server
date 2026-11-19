/**
 * FixMate refund-history contract test (development only).
 *
 * Reproduces — end to end — the exact scenario that broke the customer's
 * My Payments page in production:
 *   1. Paid booking + payment seeded in the (isolated) development database;
 *   2. Customer submits a refund request through the API;
 *   3. GET /api/payments/my then returns the payment with the refund
 *      embedded — assert the exact customer-facing refund DTO shape
 *      (NO paymentId, NO Stripe internals, all required fields present);
 *   4. Admin approves with a mocked Stripe refund API -> Stripe success;
 *   5. GET /api/payments/my returns the refund as succeeded with decidedAt;
 *   6. A rejected lane and a failed lane verify those payload states too.
 *
 * Every asserted field name/type matches the customer frontend parser
 * (fixmate-client/src/lib/payment-history.ts) — this test pins the
 * front/back contract. Throwaway users/bookings/payments are removed.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: STRIPE_CURRENCY (defaults to usd for the test).
 * Usage: node scripts/refund-history-test.mjs
 */
import "dotenv/config";
import http from "node:http";
import net from "node:net";
import { MongoClient, ObjectId } from "mongodb";

process.env.STRIPE_SECRET_KEY = "sk_test_mock_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock_test_secret_0123456789";
process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";
delete process.env.STRIPE_API_BASE;
delete process.env.BETTER_AUTH_URL;

const TEST_CURRENCY = process.env.STRIPE_CURRENCY;
const TEST_ORIGIN = process.env.TEST_ORIGIN ?? "http://localhost:3000";
const stamp = Date.now();
const CUSTOMER_EMAIL = `fixmate.refundhist.customer.${stamp}@example.com`;
const ADMIN_EMAIL = `fixmate.refundhist.admin.${stamp}@example.com`;
const TEST_PASSWORD = crypto.randomUUID() + "Aa1!";

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
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const api = async (base, path, options = {}) => {
  const res = await fetch(`${base}${path}`, { redirect: "manual", ...options });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const jsonHeaders = (origin = TEST_ORIGIN) => ({
  "content-type": "application/json",
  origin,
});
const authHeader = (token) => ({ authorization: `Bearer ${token}` });

const main = async () => {
  const appPort = await getFreePort();
  const mockPort = await getFreePort();
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${appPort}`;
  const APP_BASE = `http://127.0.0.1:${appPort}`;

  console.log(`Refund-history contract test (in-process API on :${appPort}, mock Stripe on :${mockPort})`);
  console.log(`Customer: ${CUSTOMER_EMAIL}\n`);

  // --- Mock Stripe: refunds only -------------------------------------------
  let refundsCreated = 0;
  let refundMode = "success"; // "success" | "error"
  const mockStripe = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock");
      if (req.method === "POST" && url.pathname === "/v1/refunds") {
        refundsCreated += 1;
        const params = new URLSearchParams(body);
        if (refundMode === "error") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Charge already refunded" } }));
          return;
        }
        const amount = Number(params.get("amount"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `re_mock_${refundsCreated}`,
          object: "refund",
          amount,
          currency: (params.get("currency") ?? TEST_CURRENCY).toLowerCase(),
          payment_intent: params.get("payment_intent"),
          reason: params.get("reason"),
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
  try {
    await ensureIndexes();
  } catch (error) {
    console.error("index provisioning failed:", error);
    process.exit(1);
  }

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
  const payments = db.collection("payments");

  const signUp = async (email, name) => {
    const res = await api(APP_BASE, "/api/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: TEST_PASSWORD, name }),
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`signup ${email} failed: ${res.status}`);
    }
  };
  await signUp(CUSTOMER_EMAIL, "RefundHist Customer");
  await signUp(ADMIN_EMAIL, "RefundHist Admin");
  await users.updateOne({ email: ADMIN_EMAIL }, { $set: { role: "admin" } });

  const signInAndGetToken = async (email) => {
    const signin = await api(APP_BASE, "/api/auth/sign-in/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
    if (signin.status !== 200) throw new Error(`signin ${email} failed: ${signin.status}`);
    const cookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
    const tokenRes = await api(APP_BASE, "/api/auth/token", { headers: { cookie } });
    if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
      throw new Error(`token ${email} failed: ${tokenRes.status}`);
    }
    return tokenRes.body.token;
  };
  const customerToken = await signInAndGetToken(CUSTOMER_EMAIL);
  const adminToken = await signInAndGetToken(ADMIN_EMAIL);

  const customer = await users.findOne({ email: CUSTOMER_EMAIL });
  const admin = await users.findOne({ email: ADMIN_EMAIL });
  const customerId = customer._id;

  // --- Seed two completed, PAID bookings + payment records -----------------
  const now = new Date();
  const HOUR = 60 * 60 * 1000;
  const makeBooking = (id, finalAmount) => ({
    _id: id,
    serviceId: new ObjectId(),
    customerId,
    technicianId: new ObjectId(),
    customerName: "RefundHist Customer",
    customerEmail: CUSTOMER_EMAIL,
    technicianName: "Seeded Technician",
    technicianEmail: "seeded.technician@example.com",
    serviceTitle: "Seeded Repair Job",
    serviceCategory: "AC Repair",
    serviceLocation: "Seeded Location",
    serviceImage: "https://example.com/seeded.jpg",
    hourlyRate: 45,
    securityDeposit: 50,
    problemDescription: "Refund contract test booking.",
    status: "completed",
    paymentStatus: "paid",
    finalAmount,
    createdAt: new Date(now.getTime() - HOUR),
    updatedAt: new Date(now.getTime() - HOUR),
  });
  const BOOKING_APPROVE = new ObjectId();
  const BOOKING_REJECT = new ObjectId();
  const BOOKING_FAIL = new ObjectId();
  await bookings.insertMany([
    makeBooking(BOOKING_APPROVE, 150),
    makeBooking(BOOKING_REJECT, 80),
    makeBooking(BOOKING_FAIL, 60),
  ]);
  const makePaidPayment = (bookingId, amount) => ({
    _id: new ObjectId(),
    bookingId,
    customerId,
    technicianId: new ObjectId(),
    stripeSessionId: `cs_test_mock_${new ObjectId().toHexString()}`,
    stripePaymentIntentId: `pi_mock_${new ObjectId().toHexString()}`,
    checkoutUrl: "https://checkout.stripe.test/pay/mock",
    amount,
    currency: TEST_CURRENCY,
    status: "succeeded",
    createdAt: new Date(now.getTime() - HOUR),
    updatedAt: new Date(now.getTime() - HOUR),
    paidAt: new Date(now.getTime() - HOUR),
  });
  await payments.insertMany([
    makePaidPayment(BOOKING_APPROVE, 15000),
    makePaidPayment(BOOKING_REJECT, 8000),
    makePaidPayment(BOOKING_FAIL, 6000),
  ]);

  const paymentIdOf = async (bookingId) =>
    (await payments.findOne({ bookingId }))?._id;

  try {
    // =====================================================================
    // Step 1 — customer opens My Payments (pre-refund), works
    // =====================================================================
    console.log("[before refund]");
    const before = await api(APP_BASE, "/api/payments/my?page=1&limit=10", { headers: authHeader(customerToken) });
    const beforePayment = (before.body?.data ?? []).find((p) => p.bookingId === BOOKING_APPROVE.toHexString());
    check(before.status === 200 && beforePayment?.status === "succeeded",
      `My Payments loads (status ${before.status}, payment ${beforePayment?.status})`);

    // =====================================================================
    // Step 2 — customer submits a refund request
    // =====================================================================
    console.log("\n[refund submission]");
    const approvePaymentId = await paymentIdOf(BOOKING_APPROVE);
    const rejectPaymentId = await paymentIdOf(BOOKING_REJECT);
    const failPaymentId = await paymentIdOf(BOOKING_FAIL);
    const submit = async (paymentId) =>
      api(APP_BASE, `/api/payments/${paymentId.toHexString()}/refunds`, {
        method: "POST",
        headers: { ...jsonHeaders(), ...authHeader(customerToken) },
        body: JSON.stringify({ reason: "The repair failed after a week — requesting a refund." }),
      });
    const submitApprove = await submit(approvePaymentId);
    const submitReject = await submit(rejectPaymentId);
    const submitFail = await submit(failPaymentId);
    check(submitApprove.status === 201, `refund request -> ${submitApprove.status} (expected 201)`);
    check(submitReject.status === 201, `second refund request -> ${submitReject.status} (expected 201)`);
    check(submitFail.status === 201, `third refund request -> ${submitFail.status} (expected 201)`);
    check(typeof submitApprove.body?.data?.paymentId === "string" && submitApprove.body.data.paymentId === approvePaymentId.toHexString(),
      "submission response carries paymentId (client dialog parses it)");

    // =====================================================================
    // Step 3 — My Payments MUST still load; the embedded refund DTO shape
    //          is asserted exactly (this is the payload that crashed the UI)
    // =====================================================================
    console.log("\n[embedded refund DTO — the production failure payload]");
    const afterSubmit = await api(APP_BASE, "/api/payments/my?page=1&limit=10", { headers: authHeader(customerToken) });
    const withRefund = (afterSubmit.body?.data ?? []).find((p) => p.bookingId === BOOKING_APPROVE.toHexString());
    const embedded = withRefund?.refunds?.[0];
    check(afterSubmit.status === 200, `My Payments loads after submission -> ${afterSubmit.status}`);
    check(Boolean(embedded), "embedded refund record present");
    if (embedded) {
      check(typeof embedded.id === "string" && embedded.id.length > 0, "embedded refund has string id");
      check(typeof embedded.amountMinor === "number" && Number.isFinite(embedded.amountMinor), "amountMinor is a finite number");
      check(typeof embedded.amount === "number" && Number.isFinite(embedded.amount) && embedded.amount === 150, "amount is a finite major-unit number");
      check(typeof embedded.currency === "string" && embedded.currency.length > 0, "currency present");
      check(typeof embedded.reason === "string" && embedded.reason.length > 0, "reason present");
      check(typeof embedded.status === "string" && ["pending", "succeeded", "failed", "rejected"].includes(embedded.status), `status is a known value (${embedded.status})`);
      check(typeof embedded.requestedAt === "string" && !Number.isNaN(Date.parse(embedded.requestedAt)), "requestedAt is an ISO string");
      check(!("paymentId" in embedded), "embedded refund deliberately carries NO paymentId (documenting the contract)");
      check(!("stripeRefundId" in embedded) && !("idempotencyKey" in embedded) && !("decidedBy" in embedded),
        "no Stripe/internal fields in the customer-facing DTO");
    }

    // =====================================================================
    // Step 4 — admin approves the refund (mock Stripe success)
    // =====================================================================
    console.log("\n[admin approves — Stripe success]");
    const approveDecision = await api(APP_BASE, `/api/admin/refunds/${approvePaymentId.toHexString()}/${submitApprove.body.data.id}/decide`, {
      method: "POST",
      headers: { ...jsonHeaders(), ...authHeader(adminToken) },
      body: JSON.stringify({ decision: "approve", note: "Verified — refund processed." }),
    });
    check(approveDecision.status === 200, `admin approve -> ${approveDecision.status} (expected 200)`);
    const approveView = await api(APP_BASE, "/api/payments/my?page=1&limit=10", { headers: authHeader(customerToken) });
    const approvedRefund = (approveView.body?.data ?? []).find((p) => p.bookingId === BOOKING_APPROVE.toHexString())?.refunds?.[0];
    check(approvedRefund?.status === "succeeded", `customer sees succeeded refund (got ${approvedRefund?.status})`);
    check(typeof approvedRefund?.decidedAt === "string" && !Number.isNaN(Date.parse(approvedRefund.decidedAt)), "decidedAt present and parseable");
    check(approvedRefund?.decisionNote === "Verified — refund processed.", "decisionNote preserved");

    // =====================================================================
    // Step 5 — admin rejects the refund (no Stripe call)
    // =====================================================================
    console.log("\n[admin rejects — no Stripe call]");
    const rejectDecision = await api(APP_BASE, `/api/admin/refunds/${rejectPaymentId.toHexString()}/${submitReject.body.data.id}/decide`, {
      method: "POST",
      headers: { ...jsonHeaders(), ...authHeader(adminToken) },
      body: JSON.stringify({ decision: "reject", note: "Insufficient evidence of defect." }),
    });
    check(rejectDecision.status === 200, `admin reject -> ${rejectDecision.status} (expected 200)`);
    const rejectView = await api(APP_BASE, "/api/payments/my?page=1&limit=10", { headers: authHeader(customerToken) });
    const rejectedRefund = (rejectView.body?.data ?? []).find((p) => p.bookingId === BOOKING_REJECT.toHexString())?.refunds?.[0];
    check(rejectedRefund?.status === "rejected", `customer sees rejected refund (got ${rejectedRefund?.status})`);
    check(rejectedRefund?.decisionNote === "Insufficient evidence of defect.", "rejection note preserved");

    // =====================================================================
    // Step 6 — admin approves; Stripe fails -> refund marked failed
    // =====================================================================
    console.log("\n[admin approves — Stripe rejects the refund]");
    refundMode = "error";
    const failDecision = await api(APP_BASE, `/api/admin/refunds/${failPaymentId.toHexString()}/${submitFail.body.data.id}/decide`, {
      method: "POST",
      headers: { ...jsonHeaders(), ...authHeader(adminToken) },
      body: JSON.stringify({ decision: "approve" }),
    });
    check(failDecision.status === 502, `admin approve with failing Stripe -> ${failDecision.status} (expected 502)`);
    const failView = await api(APP_BASE, "/api/payments/my?page=1&limit=10", { headers: authHeader(customerToken) });
    const failedRefund = (failView.body?.data ?? []).find((p) => p.bookingId === BOOKING_FAIL.toHexString())?.refunds?.[0];
    check(failedRefund?.status === "failed", `customer sees failed refund (got ${failedRefund?.status})`);
    check(typeof failedRefund?.failureReason === "string" && failedRefund.failureReason.length > 0, "failureReason recorded");

    // =====================================================================
    // Step 7 — ownership: a different customer cannot see these refunds
    // =====================================================================
    console.log("\n[ownership]");
    const intruderEmail = `fixmate.refundhist.intruder.${stamp}@example.com`;
    await signUp(intruderEmail, "RefundHist Intruder");
    const intruderToken = await signInAndGetToken(intruderEmail);
    const intruderView = await api(APP_BASE, "/api/payments/my?page=1&limit=10", { headers: authHeader(intruderToken) });
    const leaked = (intruderView.body?.data ?? []).some((p) =>
      [BOOKING_APPROVE, BOOKING_REJECT, BOOKING_FAIL].some((b) => b.toHexString() === p.bookingId));
    check(intruderView.status === 200 && !leaked, "another customer's payments/refunds are not visible");
    const intruderRefund = await api(APP_BASE, `/api/payments/${approvePaymentId.toHexString()}/refunds`, {
      method: "POST",
      headers: { ...jsonHeaders(), ...authHeader(intruderToken) },
      body: JSON.stringify({ reason: "Attempting to refund someone else's payment." }),
    });
    check(intruderRefund.status === 404, `another customer's refund request -> ${intruderRefund.status} (expected 404)`);
    var INTRUDER_ID = await users.findOne({ email: intruderEmail });
    await db.collection("session").deleteMany({ userId: INTRUDER_ID._id.toHexString() });
    await db.collection("account").deleteMany({ userId: INTRUDER_ID._id.toHexString() });
    await users.deleteOne({ _id: INTRUDER_ID._id });
  } finally {
    const seededIds = [customer._id, admin._id];
    await payments.deleteMany({ customerId: { $in: seededIds } });
    await bookings.deleteMany({ customerId: { $in: seededIds } });
    await sessions.deleteMany({ userId: { $in: seededIds.map(String) } });
    await accounts.deleteMany({ userId: { $in: seededIds.map(String) } });
    await users.deleteMany({ _id: { $in: seededIds } });
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mockStripe.close(resolve));
    await client.close();
    await closeDB();
    console.log("\ncleanup: seeded data and throwaway accounts removed, servers closed");
  }

  console.log(`\n${failures === 0 ? "REFUND-HISTORY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("refund-history test crashed:", error);
  process.exit(1);
});
