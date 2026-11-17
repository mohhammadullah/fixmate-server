/**
 * FixMate payments end-to-end test (development only).
 *
 * Fully self-contained: boots its own copy of the API on an ephemeral port
 * with a mock of the Stripe HTTP API, uses the real (development) MongoDB
 * database, creates a throwaway account through the public signup path, and
 * cleans up everything it created. No real Stripe keys are required or used.
 *
 * What it covers: anonymous/non-customer access, checkout preconditions
 * (completed/unpaid/finalAmount), ownership, client tampering, duplicate
 * concurrent checkout creation, webhook signature checks, successful
 * webhook processing, duplicate webhook delivery, amount/currency/metadata
 * mismatch, expired sessions, and payment-history ownership.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: STRIPE_CURRENCY (defaults to usd for the test).
 * Usage: node scripts/payments-test.mjs
 */
import "dotenv/config";
import http from "node:http";
import net from "node:net";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

process.env.STRIPE_SECRET_KEY = "sk_test_mock_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock_test_secret_0123456789";
process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";
delete process.env.STRIPE_API_BASE; // re-set below once the mock listens
delete process.env.BETTER_AUTH_URL; // re-set below once the app port is known

const TEST_WHSEC = process.env.STRIPE_WEBHOOK_SECRET;
const TEST_CURRENCY = process.env.STRIPE_CURRENCY;
const TEST_ORIGIN = process.env.TEST_ORIGIN ?? "http://localhost:3000";
const TEST_EMAIL = `fixmate.payments.test.${Date.now()}@example.com`;
const TEST_PASSWORD = crypto.randomUUID() + "Aa1!";
const TEST_NAME = "FixMate Payments Test";

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

const main = async () => {
  const appPort = await getFreePort();
  const mockPort = await getFreePort();
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${appPort}`;

  const APP_BASE = `http://127.0.0.1:${appPort}`;

  console.log(`Payments test (in-process API on :${appPort}, mock Stripe on :${mockPort})`);
  console.log(`Test account: ${TEST_EMAIL}\n`);

  // --- Mock Stripe API ---------------------------------------------------
  let checkoutSessionCalls = 0;
  const mockStripe = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock");

      if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        checkoutSessionCalls += 1;
        const params = new URLSearchParams(body);
        const unitAmount = Number(params.get("line_items[0][price_data][unit_amount]"));
        const currency = (params.get("currency") ?? TEST_CURRENCY).toLowerCase();
        const id = `cs_test_mock_${checkoutSessionCalls}`;
        const metadata = {};
        for (const key of ["bookingId", "customerId"]) {
          const value = params.get(`metadata[${key}]`);
          if (value) metadata[key] = value;
        }
        const session = {
          id,
          object: "checkout.session",
          status: "open",
          mode: "payment",
          amount_total: unitAmount,
          amount_subtotal: unitAmount,
          currency,
          url: `https://checkout.stripe.test/pay/${id}`,
          expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
          payment_intent: null,
          payment_status: "unpaid",
          livemode: false,
          metadata,
          client_reference_id: params.get("client_reference_id"),
          success_url: params.get("success_url"),
          cancel_url: params.get("cancel_url"),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(session));
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

  // Dynamic imports AFTER the test env is in place (dotenv does not
  // override variables that are already set).
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

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const bookings = db.collection("bookings");
  const payments = db.collection("payments");

  // --- Throwaway account (role is customer at signup) ---
  const signup = await api(APP_BASE, "/api/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME }),
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`signup failed with status ${signup.status}: ${JSON.stringify(signup.body)}`);
  }
  const testUser = await users.findOne({ email: TEST_EMAIL });
  if (!testUser) throw new Error("test user was not created");
  const userId = testUser._id;

  const signin = await api(APP_BASE, "/api/auth/sign-in/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (signin.status !== 200) throw new Error(`signin failed with status ${signin.status}`);
  const setCookie = signin.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.includes("session_token"))?.split(";")[0];
  if (!sessionCookie) throw new Error("no session cookie from signin");

  const getJwt = async () => {
    const tokenRes = await api(APP_BASE, "/api/auth/token", {
      headers: { cookie: sessionCookie },
    });
    if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
      throw new Error(`could not obtain JWT (status ${tokenRes.status})`);
    }
    return tokenRes.body.token;
  };
  const authHeader = (token) => ({ authorization: `Bearer ${token}` });
  const switchRole = async (role) => {
    await users.updateOne({ _id: userId }, { $set: { role } });
    return getJwt();
  };

  // --- Seed bookings ------------------------------------------------------
  const now = new Date();
  const HOUR = 60 * 60 * 1000;
  const makeBooking = (id, overrides = {}) => ({
    _id: id,
    serviceId: new ObjectId(),
    customerId: userId,
    technicianId: new ObjectId(),
    customerName: TEST_NAME,
    customerEmail: TEST_EMAIL,
    technicianName: "Seeded Technician",
    technicianEmail: "seeded.technician@example.com",
    serviceTitle: "Seeded Repair Job",
    serviceCategory: "AC Repair",
    serviceLocation: "Seeded Location",
    serviceImage: "https://example.com/seeded.jpg",
    hourlyRate: 45,
    securityDeposit: 50,
    problemDescription: "Seeded problem description for the payments test.",
    status: "completed",
    paymentStatus: "unpaid",
    finalAmount: 150,
    createdAt: new Date(now.getTime() - HOUR),
    updatedAt: new Date(now.getTime() - HOUR),
    ...overrides,
  });

  const BOOKING = {
    A: new ObjectId(), // happy path checkout + reuse
    B: new ObjectId(), // not completed -> 409
    C: new ObjectId(), // already paid -> 409
    D: new ObjectId(), // completed but missing finalAmount -> 409
    E: new ObjectId(), // concurrency test
    F: new ObjectId(), // webhook amount mismatch
    G: new ObjectId(), // webhook success + duplicate delivery
    H: new ObjectId(), // expired session flow
    I: new ObjectId(), // webhook currency mismatch
    J: new ObjectId(), // webhook metadata mismatch
    K: new ObjectId(), // async payment failed flow
  };
  const FOREIGN_BOOKING_ID = new ObjectId();

  await bookings.insertMany([
    makeBooking(BOOKING.A, {}),
    makeBooking(BOOKING.B, { status: "accepted", finalAmount: undefined, paymentStatus: "unpaid" }),
    makeBooking(BOOKING.C, { paymentStatus: "paid", finalAmount: 200 }),
    makeBooking(BOOKING.D, { finalAmount: undefined }),
    makeBooking(BOOKING.E, { finalAmount: 80 }),
    makeBooking(BOOKING.F, { finalAmount: 99 }),
    makeBooking(BOOKING.G, { finalAmount: 120 }),
    makeBooking(BOOKING.H, { finalAmount: 45 }),
    makeBooking(BOOKING.I, { finalAmount: 30 }),
    makeBooking(BOOKING.J, { finalAmount: 77 }),
    makeBooking(BOOKING.K, { finalAmount: 25 }),
    makeBooking(FOREIGN_BOOKING_ID, { customerId: new ObjectId() }),
  ]);

  const foreignPaymentId = new ObjectId();
  await payments.insertOne({
    _id: foreignPaymentId,
    bookingId: new ObjectId(),
    customerId: new ObjectId(),
    technicianId: new ObjectId(),
    stripeSessionId: "cs_test_foreign",
    checkoutUrl: "https://checkout.stripe.test/pay/cs_test_foreign",
    amount: 5000,
    currency: TEST_CURRENCY,
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
    paidAt: now,
  });

  const checkoutPayload = (bookingId) => ({
    bookingId: bookingId.toHexString(),
  });

  const createCheckout = (token, bookingId, body) =>
    api(APP_BASE, "/api/payments/checkout-session", {
      method: "POST",
      headers: { ...jsonHeaders(), ...authHeader(token) },
      body: JSON.stringify(body ?? checkoutPayload(bookingId)),
    });

  const sendWebhook = async (event) => {
    const payload = JSON.stringify(event);
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: TEST_WHSEC,
    });
    return api(APP_BASE, "/api/payments/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload,
    });
  };

  const completedSessionEvent = (payment, overrides = {}) => ({
    id: `evt_${payment._id.toHexString()}`,
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: payment.stripeSessionId,
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        amount_total: payment.amount,
        currency: payment.currency,
        payment_intent: `pi_mock_${payment._id.toHexString()}`,
        metadata: { bookingId: payment.bookingId.toHexString(), customerId: payment.customerId.toHexString() },
        ...(overrides.session ?? {}),
      },
    },
    ...overrides.event,
  });

  try {
    const customerToken = await getJwt();

    // --- Unauthenticated -------------------------------------------------
    console.log("[unauthenticated]");
    const anonCheckout = await api(APP_BASE, "/api/payments/checkout-session", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(checkoutPayload(BOOKING.A)),
    });
    check(anonCheckout.status === 401, `checkout without token -> ${anonCheckout.status} (expected 401)`);
    const anonHistory = await api(APP_BASE, "/api/payments/my");
    check(anonHistory.status === 401, `GET /api/payments/my without token -> ${anonHistory.status} (expected 401)`);

    // --- Non-customer roles ------------------------------------------------
    console.log("\n[technician role]");
    const technicianToken = await switchRole("technician");
    const techCheckout = await createCheckout(technicianToken, BOOKING.A, checkoutPayload(BOOKING.A));
    check(techCheckout.status === 403, `checkout as technician -> ${techCheckout.status} (expected 403)`);
    const techHistory = await api(APP_BASE, "/api/payments/my", { headers: authHeader(technicianToken) });
    check(techHistory.status === 403, `GET /api/payments/my as technician -> ${techHistory.status} (expected 403)`);

    console.log("\n[admin role]");
    const adminToken = await switchRole("admin");
    const adminCheckout = await createCheckout(adminToken, BOOKING.A, checkoutPayload(BOOKING.A));
    check(adminCheckout.status === 403, `checkout as admin -> ${adminCheckout.status} (expected 403)`);
    await users.updateOne({ _id: userId }, { $set: { role: "customer" } });
    const restoredToken = await getJwt();

    // --- Ownership / precondition failures ---------------------------------
    console.log("\n[ownership & booking state]");
    const foreign = await createCheckout(restoredToken, FOREIGN_BOOKING_ID, checkoutPayload(FOREIGN_BOOKING_ID));
    check(foreign.status === 404, `checkout for another customer's booking -> ${foreign.status} (expected 404)`);
    const missing = await createCheckout(restoredToken, new ObjectId(), { bookingId: new ObjectId().toHexString() });
    check(missing.status === 404, `checkout for non-existent booking -> ${missing.status} (expected 404)`);
    const notCompleted = await createCheckout(restoredToken, BOOKING.B, checkoutPayload(BOOKING.B));
    check(notCompleted.status === 409, `checkout for accepted booking -> ${notCompleted.status} (expected 409)`);
    const alreadyPaid = await createCheckout(restoredToken, BOOKING.C, checkoutPayload(BOOKING.C));
    check(alreadyPaid.status === 409, `checkout for paid booking -> ${alreadyPaid.status} (expected 409)`);
    const noFinalAmount = await createCheckout(restoredToken, BOOKING.D, checkoutPayload(BOOKING.D));
    check(noFinalAmount.status === 409, `checkout with missing finalAmount -> ${noFinalAmount.status} (expected 409)`);

    // --- Client tampering ---------------------------------------------------
    console.log("\n[client tampering rejected]");
    for (const [label, body] of [
      ["amount", { ...checkoutPayload(BOOKING.A), amount: 1 }],
      ["currency", { ...checkoutPayload(BOOKING.A), currency: "eur" }],
      ["customerId", { ...checkoutPayload(BOOKING.A), customerId: userId.toHexString() }],
      ["paymentStatus", { ...checkoutPayload(BOOKING.A), paymentStatus: "paid" }],
      ["malformed bookingId", { bookingId: "not-a-booking-id" }],
    ]) {
      const res = await createCheckout(restoredToken, BOOKING.A, body);
      check(res.status === 400, `tampered body (${label}) -> ${res.status} (expected 400)`);
    }

    // --- Happy path ----------------------------------------------------------
    console.log("\n[checkout session]");
    const happy = await createCheckout(restoredToken, BOOKING.A, checkoutPayload(BOOKING.A));
    check(happy.status === 201 && happy.body?.success === true, `checkout -> ${happy.status} (expected 201)`);
    check(typeof happy.body?.data?.url === "string" && happy.body.data.url.startsWith("https://checkout.stripe.test/"), "checkout returns the Stripe-hosted URL");
    check(happy.body?.data?.amount === 150 && happy.body?.data?.currency === TEST_CURRENCY, "response amount/currency come from the server-side record");
    check(!("checkoutUrl" in (happy.body?.data ?? {})), "response does not echo internal field names");
    check(checkoutSessionCalls === 1, `mock Stripe saw ${checkoutSessionCalls} session creation(s) (expected 1)`);

    const pendingPayment = await payments.findOne({ bookingId: BOOKING.A, status: "pending" });
    check(Boolean(pendingPayment), "pending payment record stored");
    check(pendingPayment?.amount === 15000 && pendingPayment?.currency === TEST_CURRENCY, "payment stored in minor units with currency");
    check(typeof pendingPayment?.stripeSessionId === "string" && pendingPayment.stripeSessionId.startsWith("cs_test_mock_"), "Stripe session id stored");
    check(pendingPayment?.checkoutUrl?.startsWith("https://checkout.stripe.test/"), "checkout URL stored");

    const repeat = await createCheckout(restoredToken, BOOKING.A, checkoutPayload(BOOKING.A));
    check(repeat.status === 200 && repeat.body?.data?.url === happy.body?.data?.url, "repeat checkout reuses the same pending session (idempotent)");
    check(checkoutSessionCalls === 1, `mock Stripe still saw ${checkoutSessionCalls} creation(s) after retry (expected 1)`);

    // --- Duplicate concurrent checkout creation ------------------------------
    console.log("\n[concurrent checkout creation]");
    const callsBefore = checkoutSessionCalls;
    const [race1, race2] = await Promise.all([
      createCheckout(restoredToken, BOOKING.E, checkoutPayload(BOOKING.E)),
      createCheckout(restoredToken, BOOKING.E, checkoutPayload(BOOKING.E)),
    ]);
    check(race1.status === 201 || race2.status === 201, "one of the concurrent requests created the session");
    check(race1.status !== 500 && race2.status !== 500, `neither concurrent request failed (got ${race1.status}/${race2.status})`);
    check(race1.body?.data?.url && race1.body?.data?.url === race2.body?.data?.url, "concurrent requests received the same hosted URL");
    check(checkoutSessionCalls === callsBefore + 1, `exactly one Stripe session created under concurrency (got ${checkoutSessionCalls - callsBefore})`);
    const pendingE = await payments.countDocuments({ bookingId: BOOKING.E, status: "pending" });
    check(pendingE === 1, `exactly one pending payment record for the booking (got ${pendingE})`);

    // --- Webhook: invalid signature ------------------------------------------
    console.log("\n[webhook signature]");
    const badSig = await api(APP_BASE, "/api/payments/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: JSON.stringify({ id: "evt_x", object: "event", type: "checkout.session.completed", data: { object: {} } }),
    });
    check(badSig.status === 400, `webhook with invalid signature -> ${badSig.status} (expected 400)`);
    const noSig = await api(APP_BASE, "/api/payments/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    check(noSig.status === 400, `webhook without signature -> ${noSig.status} (expected 400)`);

    const gCheckout = await createCheckout(restoredToken, BOOKING.G, checkoutPayload(BOOKING.G));
    check(gCheckout.status === 201, `checkout for webhook-success booking -> ${gCheckout.status}`);
    const gPayment = await payments.findOne({ bookingId: BOOKING.G });

    // --- Webhook: amount mismatch -------------------------------------------
    console.log("\n[webhook amount mismatch]");
    const fCheckout = await createCheckout(restoredToken, BOOKING.F, checkoutPayload(BOOKING.F));
    check(fCheckout.status === 201, `checkout for mismatch booking -> ${fCheckout.status}`);
    const fPayment = await payments.findOne({ bookingId: BOOKING.F });
    const amountMismatch = await sendWebhook(completedSessionEvent(fPayment, { session: { amount_total: fPayment.amount + 100 } }));
    check(amountMismatch.status === 200, `webhook with wrong amount -> ${amountMismatch.status} (expected 200, ignored)`);
    const fAfter = await payments.findOne({ _id: fPayment._id });
    check(fAfter.status === "failed", `payment marked failed on amount mismatch (got ${fAfter.status})`);
    const fBooking = await bookings.findOne({ _id: BOOKING.F });
    check(fBooking.paymentStatus === "unpaid", "booking stays unpaid after amount mismatch");

    // --- Webhook: currency mismatch ------------------------------------------
    console.log("\n[webhook currency mismatch]");
    const iCheckout = await createCheckout(restoredToken, BOOKING.I, checkoutPayload(BOOKING.I));
    check(iCheckout.status === 201, `checkout for currency-mismatch booking -> ${iCheckout.status}`);
    const iPayment = await payments.findOne({ bookingId: BOOKING.I });
    const currencyMismatch = await sendWebhook(completedSessionEvent(iPayment, { session: { currency: "eur" } }));
    check(currencyMismatch.status === 200, `webhook with wrong currency -> ${currencyMismatch.status} (expected 200, ignored)`);
    const iAfter = await payments.findOne({ _id: iPayment._id });
    check(iAfter.status === "failed", `payment marked failed on currency mismatch (got ${iAfter.status})`);
    const iBooking = await bookings.findOne({ _id: BOOKING.I });
    check(iBooking.paymentStatus === "unpaid", "booking stays unpaid after currency mismatch");

    // --- Webhook: metadata booking mismatch -----------------------------------
    console.log("\n[webhook session mismatch]");
    const jCheckout = await createCheckout(restoredToken, BOOKING.J, checkoutPayload(BOOKING.J));
    check(jCheckout.status === 201, `checkout for metadata-mismatch booking -> ${jCheckout.status}`);
    const jPayment = await payments.findOne({ bookingId: BOOKING.J });
    const metadataMismatch = await sendWebhook(
      completedSessionEvent(jPayment, { session: { metadata: { bookingId: new ObjectId().toHexString() } } })
    );
    check(metadataMismatch.status === 200, `webhook with wrong metadata -> ${metadataMismatch.status} (expected 200, ignored)`);
    const jAfter = await payments.findOne({ _id: jPayment._id });
    check(jAfter.status === "failed", `payment marked failed on metadata mismatch (got ${jAfter.status})`);
    const jBooking = await bookings.findOne({ _id: BOOKING.J });
    check(jBooking.paymentStatus === "unpaid", "booking stays unpaid after metadata mismatch");

    // --- Webhook: unknown session ---------------------------------------------
    console.log("\n[webhook unknown session]");
    const unknown = await sendWebhook({
      id: "evt_unknown",
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_test_mock_999",
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          amount_total: 100,
          currency: TEST_CURRENCY,
          payment_intent: "pi_unknown",
          metadata: { bookingId: new ObjectId().toHexString() },
        },
      },
    });
    check(unknown.status === 200, `webhook for unknown session -> ${unknown.status} (expected 200, ignored)`);

    // --- Webhook: successful processing ----------------------------------------
    console.log("\n[webhook success]");
    const successResult = await sendWebhook(completedSessionEvent(gPayment));
    check(successResult.status === 200, `successful webhook -> ${successResult.status} (expected 200)`);
    const gAfter = await payments.findOne({ _id: gPayment._id });
    check(gAfter.status === "succeeded", `payment marked succeeded (got ${gAfter.status})`);
    check(Boolean(gAfter.paidAt), "payment has paidAt timestamp");
    check(gAfter.stripePaymentIntentId === `pi_mock_${gPayment._id.toHexString()}`, "payment intent id stored");
    const gBooking = await bookings.findOne({ _id: BOOKING.G });
    check(gBooking.paymentStatus === "paid", "booking marked paid after verified webhook");

    // --- Webhook: duplicate delivery -------------------------------------------
    console.log("\n[webhook duplicate delivery]");
    const duplicate = await sendWebhook(completedSessionEvent(gPayment));
    check(duplicate.status === 200, `duplicate webhook -> ${duplicate.status} (expected 200)`);
    const gAfterDup = await payments.findOne({ _id: gPayment._id });
    check(gAfterDup.status === "succeeded", "payment remains succeeded after duplicate delivery");
    const gBookingDup = await bookings.findOne({ _id: BOOKING.G });
    check(gBookingDup.paymentStatus === "paid", "booking remains paid after duplicate delivery");

    // --- Checkout after webhook: already paid ---------------------------------
    const checkoutAfterPay = await createCheckout(restoredToken, BOOKING.G, checkoutPayload(BOOKING.G));
    check(checkoutAfterPay.status === 409, `checkout for now-paid booking -> ${checkoutAfterPay.status} (expected 409)`);

    // --- Webhook: expired session -----------------------------------------------
    console.log("\n[webhook expired session]");
    const hCheckout = await createCheckout(restoredToken, BOOKING.H, checkoutPayload(BOOKING.H));
    check(hCheckout.status === 201, `checkout for expired-flow booking -> ${hCheckout.status}`);
    const hPayment = await payments.findOne({ bookingId: BOOKING.H });
    const expiredEvent = {
      id: `evt_exp_${hPayment._id.toHexString()}`,
      object: "event",
      type: "checkout.session.expired",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: hPayment.stripeSessionId,
          object: "checkout.session",
          status: "expired",
          payment_status: "unpaid",
          amount_total: hPayment.amount,
          currency: hPayment.currency,
          metadata: { bookingId: BOOKING.H.toHexString(), customerId: userId.toHexString() },
        },
      },
    };
    const expiredResult = await sendWebhook(expiredEvent);
    check(expiredResult.status === 200, `expired webhook -> ${expiredResult.status} (expected 200)`);
    const hAfter = await payments.findOne({ _id: hPayment._id });
    check(hAfter.status === "expired", `payment marked expired (got ${hAfter.status})`);
    const hBooking = await bookings.findOne({ _id: BOOKING.H });
    check(hBooking.paymentStatus === "unpaid", "booking stays unpaid after session expiry");
    const hRetry = await createCheckout(restoredToken, BOOKING.H, checkoutPayload(BOOKING.H));
    check(hRetry.status === 201, `customer can open a fresh checkout after expiry -> ${hRetry.status}`);

    // --- Webhook: async payment failed -------------------------------------------
    console.log("\n[webhook async payment failed]");
    const kCheckout = await createCheckout(restoredToken, BOOKING.K, checkoutPayload(BOOKING.K));
    check(kCheckout.status === 201, `checkout for failed-flow booking -> ${kCheckout.status}`);
    const kPayment = await payments.findOne({ bookingId: BOOKING.K });
    const failedEvent = {
      id: `evt_fail_${kPayment._id.toHexString()}`,
      object: "event",
      type: "checkout.session.async_payment_failed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: kPayment.stripeSessionId,
          object: "checkout.session",
          status: "expired",
          payment_status: "unpaid",
          amount_total: kPayment.amount,
          currency: kPayment.currency,
          metadata: { bookingId: BOOKING.K.toHexString(), customerId: userId.toHexString() },
        },
      },
    };
    const failedResult = await sendWebhook(failedEvent);
    check(failedResult.status === 200, `async-payment-failed webhook -> ${failedResult.status} (expected 200)`);
    const kAfter = await payments.findOne({ _id: kPayment._id });
    check(kAfter.status === "failed", `payment marked failed (got ${kAfter.status})`);
    const kBooking = await bookings.findOne({ _id: BOOKING.K });
    check(kBooking.paymentStatus === "unpaid", "booking stays unpaid after async payment failure");

    // --- Payment history ---------------------------------------------------------
    console.log("\n[payment history]");
    const history = await api(APP_BASE, "/api/payments/my", { headers: authHeader(restoredToken) });
    check(history.status === 200 && history.body?.success === true, `GET /api/payments/my -> ${history.status} (expected 200)`);
    const historyItems = history.body?.data ?? [];
    check(Array.isArray(historyItems) && historyItems.length > 0, "history returns the customer's payments");
    check(
      historyItems.every((item) => item.id !== foreignPaymentId.toHexString()),
      "another customer's payment record is not returned"
    );
    check(
      historyItems.every((item) => !("stripeSessionId" in item) && !("checkoutUrl" in item) && !("technicianId" in item) && !("_id" in item)),
      "history DTOs expose no Stripe or Mongo internals"
    );
    check(
      historyItems.every((item) => typeof item.amount === "number" && typeof item.currency === "string" && typeof item.bookingId === "string" && typeof item.status === "string" && typeof item.createdAt === "string"),
      "history DTOs carry id, booking reference, amount, currency, status and date"
    );
    check(
      historyItems.some((item) => item.status === "succeeded" && item.paidAt),
      "succeeded payment appears with paidAt"
    );
    check(
      history.body?.pagination?.totalItems === historyItems.length || history.body?.pagination?.totalItems >= historyItems.length,
      "pagination metadata is present"
    );

    const paged = await api(APP_BASE, "/api/payments/my?limit=2&page=1", { headers: authHeader(restoredToken) });
    check(
      paged.status === 200 && paged.body?.data?.length === 2 &&
        paged.body?.pagination?.limit === 2 &&
        paged.body?.pagination?.currentPage === 1 &&
        paged.body?.pagination?.totalItems >= 2,
      "pagination limit/page applied"
    );
    for (const [label, query] of [
      ["page=abc", "page=abc"],
      ["page=0", "page=0"],
      ["limit=51", "limit=51"],
      ["limit=0", "limit=0"],
    ]) {
      const res = await api(APP_BASE, `/api/payments/my?${query}`, { headers: authHeader(restoredToken) });
      check(res.status === 400, `GET /api/payments/my?${label} -> ${res.status} (expected 400)`);
    }
  } finally {
    // --- Cleanup ---------------------------------------------------------------
    await payments.deleteMany({ customerId: userId });
    await payments.deleteOne({ _id: foreignPaymentId });
    await bookings.deleteMany({ customerId: userId });
    await bookings.deleteOne({ _id: FOREIGN_BOOKING_ID });
    await sessions.deleteMany({ userId });
    await accounts.deleteMany({ userId });
    await users.deleteOne({ _id: userId });
    console.log("\ncleanup: seeded bookings/payments removed, throwaway account deleted");

    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mockStripe.close(resolve));
    await client.close();
    await closeDB();
  }

  console.log(`\n${failures === 0 ? "PAYMENTS CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("payments test crashed:", error);
  process.exit(1);
});
