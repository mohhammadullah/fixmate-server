/**
 * FixMate thin-payload webhook reconciliation test (development only).
 *
 * Verifies the settlement path against Checkout Sessions whose webhook
 * events carry NO payment_status — the "thin payload" style emitted by
 * Stripe Event Destinations configured with thin payloads. The handler must
 * re-fetch the session from the Stripe API and reconcile against that, and
 * never silently drop a possibly-paid session:
 *   - thin payload + Stripe truth "paid"   -> payment settles, booking paid
 *   - thin payload + Stripe truth "unpaid" -> stays pending, booking unpaid
 *   - thin payload + retrieve fails        -> webhook answers 500 (Stripe retries)
 *   - malformed thin id                    -> acknowledged 200, no state change
 *   - thin payload whose retrieved metadata targets a different booking
 *                                           -> payment failed, bookings untouched
 *   - duplicate thin delivery               -> idempotent (no double settlement)
 *
 * Uses a mock of the Stripe HTTP API; the real (development) database; a
 * throwaway customer created through the public signup path. Self-contained:
 * `node scripts/thin-webhook-test.mjs`.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: STRIPE_CURRENCY (defaults to usd for the test).
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
const TEST_EMAIL = `fixmate.thin.webhook.test.${Date.now()}@example.com`;
const TEST_PASSWORD = crypto.randomUUID() + "Aa1!";
const TEST_NAME = "FixMate Thin Webhook Test";

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

  console.log(`Thin-payload webhook test (in-process API on :${appPort}, mock Stripe on :${mockPort})`);
  console.log(`Test account: ${TEST_EMAIL}\n`);

  // --- Mock Stripe API ---------------------------------------------------
  // Sessions are remembered at creation; the GET /v1/checkout/sessions/:id
  // response is controlled per scenario by `retrieveMode`.
  let checkoutSessionCalls = 0;
  const sessionsById = new Map();
  let retrieveMode = "paid"; // "paid" | "unpaid" | "error" | "notfound" | "mismatch"

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
        sessionsById.set(id, session);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(session));
        return;
      }

      const getMatch = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
      if (req.method === "GET" && getMatch) {
        if (retrieveMode === "error") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "mock stripe failure" } }));
          return;
        }
        const stored = sessionsById.get(getMatch[1]);
        if (retrieveMode === "notfound" || !stored) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "No such checkout session" } }));
          return;
        }
        const full = {
          ...stored,
          status: "complete",
          payment_intent: `pi_mock_${stored.id}`,
          payment_status: retrieveMode === "unpaid" ? "unpaid" : "paid",
          ...(retrieveMode === "mismatch"
            ? { metadata: { ...stored.metadata, bookingId: new ObjectId().toHexString() } }
            : {}),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(full));
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
  const sessionCookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
  if (!sessionCookie) throw new Error("no session cookie from signin");

  const tokenRes = await api(APP_BASE, "/api/auth/token", { headers: { cookie: sessionCookie } });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`could not obtain JWT (status ${tokenRes.status})`);
  }
  const customerToken = tokenRes.body.token;
  const authHeader = { authorization: `Bearer ${customerToken}` };

  const now = new Date();
  const HOUR = 60 * 60 * 1000;
  const makeBooking = (id, finalAmount) => ({
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
    problemDescription: "Seeded problem description for the thin-payload test.",
    status: "completed",
    paymentStatus: "unpaid",
    finalAmount,
    createdAt: new Date(now.getTime() - HOUR),
    updatedAt: new Date(now.getTime() - HOUR),
  });

  const BOOKING = {
    A: new ObjectId(), // thin payload, Stripe truth paid -> settles
    B: new ObjectId(), // thin payload, Stripe truth unpaid -> stays pending
    C: new ObjectId(), // thin payload, retrieve fails -> 500 (Stripe retries)
    D: new ObjectId(), // thin payload, malformed id -> ack 200, no state change
    E: new ObjectId(), // thin payload, duplicate delivery -> idempotent
    F: new ObjectId(), // thin payload, retrieved metadata mismatch -> failed
    G: new ObjectId(), // thin payload, retrieve 404 -> 500 (Stripe retries)
  };
  await bookings.insertMany([
    makeBooking(BOOKING.A, 150),
    makeBooking(BOOKING.B, 55),
    makeBooking(BOOKING.C, 45),
    makeBooking(BOOKING.D, 25),
    makeBooking(BOOKING.E, 120),
    makeBooking(BOOKING.F, 77),
    makeBooking(BOOKING.G, 33),
  ]);

  const createCheckout = (bookingId) =>
    api(APP_BASE, "/api/payments/checkout-session", {
      method: "POST",
      headers: { ...jsonHeaders(), ...authHeader },
      body: JSON.stringify({ bookingId: bookingId.toHexString() }),
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

  // The thin event object deliberately carries NO payment_status, amount,
  // currency or metadata — exactly what a thin payload looks like.
  const thinCompleted = (payment) => ({
    id: `evt_thin_${payment._id.toHexString()}`,
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: payment.stripeSessionId,
        object: "checkout.session",
      },
    },
  });

  const paymentFor = (bookingId) => payments.findOne({ bookingId });
  const bookingFor = (bookingId) => bookings.findOne({ _id: bookingId });

  try {
    const checkoutIds = {};
    for (const key of ["A", "B", "C", "D", "E", "F", "G"]) {
      const res = await createCheckout(BOOKING[key]);
      if (res.status !== 201) throw new Error(`checkout ${key} failed: ${res.status} ${JSON.stringify(res.body)}`);
      checkoutIds[key] = res;
    }
    const paymentA = await paymentFor(BOOKING.A);
    const paymentB = await paymentFor(BOOKING.B);
    const paymentC = await paymentFor(BOOKING.C);
    const paymentD = await paymentFor(BOOKING.D);
    const paymentE = await paymentFor(BOOKING.E);
    const paymentF = await paymentFor(BOOKING.F);
    const paymentG = await paymentFor(BOOKING.G);
    console.log("checkout sessions created for bookings A..G\n");

    // --- A: thin payload, Stripe truth "paid" -> settles --------------------
    console.log("[thin payload, money moved]");
    retrieveMode = "paid";
    const aRes = await sendWebhook(thinCompleted(paymentA));
    const aPayment = await paymentFor(BOOKING.A);
    const aBooking = await bookingFor(BOOKING.A);
    check(aRes.status === 200, `thin webhook -> ${aRes.status} (expected 200)`);
    check(aPayment?.status === "succeeded", `payment settled (got ${aPayment?.status})`);
    check(aBooking?.paymentStatus === "paid", "booking is paid");
    check(aBooking?.invoice?.paymentStatus === "paid", "invoice marked paid");

    // --- E: duplicate thin delivery -> idempotent --------------------------
    console.log("\n[duplicate thin delivery]");
    const eRes1 = await sendWebhook(thinCompleted(paymentE));
    const ePayment1 = await paymentFor(BOOKING.E);
    const eBooking1 = await bookingFor(BOOKING.E);
    const eRes2 = await sendWebhook(thinCompleted(paymentE));
    const ePayment2 = await paymentFor(BOOKING.E);
    const eBooking2 = await bookingFor(BOOKING.E);
    check(eRes1.status === 200 && ePayment1?.status === "succeeded" && eBooking1?.paymentStatus === "paid", "first thin delivery settles");
    check(eRes2.status === 200 && ePayment2?.status === "succeeded", `second thin delivery is idempotent -> ${eRes2.status}`);
    check(eBooking2?.paymentStatus === "paid", "booking stays paid after duplicate delivery");

    // --- B: thin payload, Stripe truth "unpaid" -> stays pending ------------
    console.log("\n[thin payload, money in flight]");
    retrieveMode = "unpaid";
    const bRes = await sendWebhook(thinCompleted(paymentB));
    const bPayment = await paymentFor(BOOKING.B);
    const bBooking = await bookingFor(BOOKING.B);
    check(bRes.status === 200, `thin webhook -> ${bRes.status} (expected 200)`);
    check(bPayment?.status === "pending", `payment stays pending (got ${bPayment?.status})`);
    check(bBooking?.paymentStatus === "unpaid", "booking stays unpaid");

    // --- C: retrieve fails -> 500 so Stripe retries -------------------------
    console.log("\n[thin payload, retrieve error]");
    retrieveMode = "error";
    const cRes = await sendWebhook(thinCompleted(paymentC));
    const cPayment = await paymentFor(BOOKING.C);
    const cBooking = await bookingFor(BOOKING.C);
    check(cRes.status === 500, `retrieve failure -> ${cRes.status} (expected 500)`);
    check(cPayment?.status === "pending", `payment stays pending (got ${cPayment?.status})`);
    check(cBooking?.paymentStatus === "unpaid", "booking stays unpaid");
    // A later retry after the transient failure settles normally.
    retrieveMode = "paid";
    const cRetry = await sendWebhook(thinCompleted(paymentC));
    const cPaymentAfter = await paymentFor(BOOKING.C);
    check(cRetry.status === 200 && cPaymentAfter?.status === "succeeded", `retry after transient failure settles -> ${cRetry.status}`);

    // --- D: malformed thin id -> ack 200, no state change -------------------
    console.log("\n[thin payload, malformed id]");
    const malformed = thinCompleted(paymentD);
    malformed.data.object.id = "garbage-session-id";
    retrieveMode = "paid"; // irrelevant — the id never reaches Stripe
    const dRes = await sendWebhook(malformed);
    const dPayment = await paymentFor(BOOKING.D);
    const dBooking = await bookingFor(BOOKING.D);
    check(dRes.status === 200, `malformed thin id -> ${dRes.status} (expected 200)`);
    check(dPayment?.status === "pending", `payment stays pending (got ${dPayment?.status})`);
    check(dBooking?.paymentStatus === "unpaid", "booking stays unpaid");

    // --- F: retrieved metadata points elsewhere -> failed, no cross-booking ---
    console.log("\n[thin payload, retrieved metadata mismatch]");
    retrieveMode = "mismatch";
    const fRes = await sendWebhook(thinCompleted(paymentF));
    const fPayment = await paymentFor(BOOKING.F);
    const fBooking = await bookingFor(BOOKING.F);
    check(fRes.status === 200, `mismatch webhook -> ${fRes.status} (expected 200)`);
    check(fPayment?.status === "failed", `payment marked failed (got ${fPayment?.status})`);
    check(fBooking?.paymentStatus === "unpaid", "target booking untouched");

    // --- G: Stripe doesn't know the session -> 500 (Stripe retries) ----------
    console.log("\n[thin payload, unknown session]");
    retrieveMode = "notfound";
    const gRes = await sendWebhook(thinCompleted(paymentG));
    const gPayment = await paymentFor(BOOKING.G);
    const gBooking = await bookingFor(BOOKING.G);
    check(gRes.status === 500, `unknown session -> ${gRes.status} (expected 500)`);
    check(gPayment?.status === "pending", `payment stays pending (got ${gPayment?.status})`);
    check(gBooking?.paymentStatus === "unpaid", "booking stays unpaid");

    // --- Unsigned thin payload -> rejected -----------------------------------
    console.log("\n[unsigned thin payload]");
    const unsigned = await api(APP_BASE, "/api/payments/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: JSON.stringify(thinCompleted(paymentG)),
    });
    check(unsigned.status === 400, `unsigned thin payload -> ${unsigned.status} (expected 400)`);
    const gAfterUnsigned = await paymentFor(BOOKING.G);
    check(gAfterUnsigned?.status === "pending", "unsigned payload cannot settle the payment");
  } finally {
    await payments.deleteMany({ customerId: userId });
    await bookings.deleteMany({ customerId: userId });
    await sessions.deleteMany({ userId });
    await accounts.deleteMany({ userId });
    await users.deleteOne({ _id: userId });
    console.log("\ncleanup: seeded bookings/payments removed, throwaway account deleted");

    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mockStripe.close(resolve));
    await client.close();
    await closeDB();
  }

  console.log(`\n${failures === 0 ? "THIN-WEBHOOK CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("thin-webhook test crashed:", error);
  process.exit(1);
});
