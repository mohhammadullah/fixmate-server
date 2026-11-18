/**
 * FixMate technician payment-history integration test (development only).
 *
 * Seeds two technicians (each with completed bookings in both payment
 * states), a customer and an admin, then exercises
 * GET /api/payments/technician end to end through an isolated API instance
 * on an ephemeral port. Stripe is not involved: payment records are seeded
 * directly to cover both the "settled" and "outstanding" shapes.
 *
 * Verifies:
 *   - ownership isolation: technician A never sees technician B's bookings,
 *     amounts or summary, even with a foreign technicianId in the query
 *   - role enforcement: customers and admins get 403; anonymous gets 401
 *   - paid vs. unpaid entries, per-currency summary totals (settled money
 *     comes from the payment record; a paid booking without a payment
 *     record still counts exactly once via its booking.finalAmount)
 *   - pagination metadata and paid/unpaid filtering
 *   - no Stripe internals (checkoutUrl, paymentIntentId) or customer
 *     contact details (customerEmail) leak into the response
 *
 * Throwaway users/bookings/payments are created and removed on completion.
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/with-isolated-app.mjs scripts/technician-payments-test.mjs
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";

if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) {
  console.error("MONGODB_URI and MONGODB_DB_NAME must be set (via .env).");
  process.exit(1);
}

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const headers = { "content-type": "application/json", origin: process.env.TEST_ORIGIN ?? "http://localhost:3000" };
const api = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual", ...options });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const auth = (token) => ({ ...headers, authorization: `Bearer ${token}` });

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

const makeUser = async (db, label, role = "customer") => {
  const email = `fixmate.techpay.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST", headers,
    body: JSON.stringify({ email, password, name: `TechPay ${label}` }),
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`signup ${label} failed: ${signup.status}`);
  }
  if (role !== "customer") {
    await db.collection("user").updateOne({ email }, { $set: { role } });
  }
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST", headers, body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) throw new Error(`signin ${label} failed: ${signin.status}`);
  const cookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
  const tokenRes = await api("/api/auth/token", { headers: { cookie } });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`token ${label} failed`);
  }
  const user = await db.collection("user").findOne({ email });
  return { email, userId: user._id, token: tokenRes.body.token };
};

const cleanup = async (db, { userIds, bookingIds, paymentIds }) => {
  if (bookingIds.length) await db.collection("bookings").deleteMany({ _id: { $in: bookingIds } });
  if (paymentIds.length) await db.collection("payments").deleteMany({ _id: { $in: paymentIds } });
  if (userIds.length) {
    await db.collection("user").deleteMany({ _id: { $in: userIds } });
    await db.collection("session").deleteMany({ userId: { $in: userIds } });
    await db.collection("account").deleteMany({ userId: { $in: userIds } });
  }
};

const main = async () => {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);

  const techA = await makeUser(db, "techa", "technician");
  const techB = await makeUser(db, "techb", "technician");
  const customer = await makeUser(db, "customer", "customer");
  const admin = await makeUser(db, "admin", "admin");
  console.log("throwaway users created: techA, techB, customer, admin\n");

  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const stamp = (hoursAgo) => new Date(now - hoursAgo * HOUR);

  const B = {
    unpaidNoPayment: new ObjectId(),   // B1: completed, unpaid, no payments
    paidWithPayment: new ObjectId(),   // B2: completed, paid, succeeded session 1
    unpaidPending: new ObjectId(),     // B3: completed, unpaid, pending session
    inProgress: new ObjectId(),        // B4: must never appear
    paidPaymentWins: new ObjectId(),   // B5: completed, paid; finalAmount != payment amount
    paidNoPaymentAnomaly: new ObjectId(), // B7: completed, paid, NO payment record
    techB: new ObjectId(),             // B6: foreign technician
  };

  const makeBooking = (id, technicianId, customerId, technicianName, overrides = {}) => ({
    _id: id,
    serviceId: new ObjectId(),
    customerId,
    technicianId,
    customerName: "Seeded Customer",
    customerEmail: "seeded.customer@example.com",
    technicianName,
    technicianEmail: "seeded.tech@example.com",
    serviceTitle: `Seeded Repair ${id.toHexString().slice(-4)}`,
    serviceCategory: "AC Repair",
    serviceLocation: "Seeded Location",
    serviceImage: "https://example.com/seeded.jpg",
    hourlyRate: 45,
    securityDeposit: 50,
    problemDescription: "Seeded problem description.",
    status: "completed",
    paymentStatus: "unpaid",
    finalAmount: 150,
    createdAt: stamp(10),
    updatedAt: stamp(10),
    ...overrides,
  });

  await db.collection("bookings").insertMany([
    makeBooking(B.unpaidNoPayment, techA.userId, customer.userId, "TechPay techA", {
      serviceTitle: "Seeded Unpaid Job", finalAmount: 150, updatedAt: stamp(5),
    }),
    makeBooking(B.paidWithPayment, techA.userId, customer.userId, "TechPay techA", {
      serviceTitle: "Seeded Paid Job", paymentStatus: "paid", finalAmount: 200, updatedAt: stamp(4),
    }),
    makeBooking(B.unpaidPending, techA.userId, customer.userId, "TechPay techA", {
      serviceTitle: "Seeded Pending Job", finalAmount: 80, updatedAt: stamp(3),
    }),
    makeBooking(B.inProgress, techA.userId, customer.userId, "TechPay techA", {
      serviceTitle: "Seeded Active Job", status: "in-progress", finalAmount: undefined, updatedAt: stamp(2),
    }),
    makeBooking(B.paidPaymentWins, techA.userId, customer.userId, "TechPay techA", {
      serviceTitle: "Seeded Payment Wins Job", paymentStatus: "paid", finalAmount: 70, updatedAt: stamp(2.5),
    }),
    makeBooking(B.paidNoPaymentAnomaly, techA.userId, customer.userId, "TechPay techA", {
      serviceTitle: "Seeded Anomaly Job", paymentStatus: "paid", finalAmount: 90, updatedAt: stamp(1),
    }),
    makeBooking(B.techB, techB.userId, customer.userId, "TechPay techB", {
      serviceTitle: "Seeded Foreign Job", paymentStatus: "paid", finalAmount: 400, updatedAt: stamp(6),
    }),
  ]);

  const P = {
    settledA: new ObjectId(),
    settledB: new ObjectId(),
    pending: new ObjectId(),
    foreign: new ObjectId(),
  };

  const makePayment = (id, bookingId, customerId, technicianId, status, amount, overrides = {}) => ({
    _id: id,
    bookingId,
    customerId,
    technicianId,
    stripeSessionId: `cs_test_techpay_${id.toHexString().slice(-6)}`,
    // checkoutUrl/paymentIntentId are seeded on purpose: the technician
    // endpoint must never echo them.
    checkoutUrl: `https://checkout.stripe.test/pay/${id.toHexString()}`,
    stripePaymentIntentId: `pi_test_${id.toHexString().slice(-6)}`,
    amount,
    currency: "usd",
    status,
    createdAt: stamp(4),
    updatedAt: stamp(4),
    paidAt: status === "succeeded" ? stamp(4) : undefined,
    ...overrides,
  });

  await db.collection("payments").insertMany([
    makePayment(P.settledA, B.paidWithPayment, customer.userId, techA.userId, "succeeded", 20000, { paidAt: stamp(4) }),
    makePayment(P.settledB, B.paidPaymentWins, customer.userId, techA.userId, "succeeded", 6500, { paidAt: stamp(2.5), updatedAt: stamp(2.5) }),
    makePayment(P.pending, B.unpaidPending, customer.userId, techA.userId, "pending", 8000, { checkoutUrl: "https://checkout.stripe.test/pay/secret-checkout-url" }),
    makePayment(P.foreign, B.techB, customer.userId, techB.userId, "succeeded", 40000, { paidAt: stamp(6) }),
  ]);

  const bookingIds = [...Object.values(B)];
  const paymentIds = [...Object.values(P)];
  const userIds = [techA.userId, techB.userId, customer.userId, admin.userId];

  try {
    console.log("[role enforcement]");
    const anonymous = await api("/api/payments/technician");
    check(anonymous.status === 401, `anonymous -> ${anonymous.status} (expected 401)`);
    const asCustomer = await api("/api/payments/technician", { headers: auth(customer.token) });
    check(asCustomer.status === 403, `customer -> ${asCustomer.status} (expected 403)`);
    const asAdmin = await api("/api/payments/technician", { headers: auth(admin.token) });
    check(asAdmin.status === 403, `admin -> ${asAdmin.status} (expected 403)`);

    console.log("\n[ownership isolation]");
    const res = await api("/api/payments/technician", { headers: auth(techA.token) });
    check(res.status === 200, `technician A -> ${res.status} (expected 200)`);
    const items = res.body?.data ?? [];
    const ids = new Set(items.map((entry) => entry.bookingId));
    check(ids.has(B.unpaidNoPayment.toHexString()), "own unpaid booking present");
    check(ids.has(B.paidWithPayment.toHexString()), "own paid booking present");
    check(ids.has(B.unpaidPending.toHexString()), "own pending-payment booking present");
    check(ids.has(B.paidPaymentWins.toHexString()), "own payment-record booking present");
    check(ids.has(B.paidNoPaymentAnomaly.toHexString()), "own anomaly booking present");
    check(!ids.has(B.inProgress.toHexString()), "in-progress booking excluded");
    check(!ids.has(B.techB.toHexString()), "foreign technician booking excluded");
    check(items.length === 5, `exactly 5 entries (got ${items.length})`);
    check(items[0]?.bookingId === B.paidNoPaymentAnomaly.toHexString(), "sorted newest activity first");

    const foreign = await api(
      `/api/payments/technician?technicianId=${techB.userId.toHexString()}`,
      { headers: auth(techA.token) }
    );
    const foreignIds = new Set((foreign.body?.data ?? []).map((entry) => entry.bookingId));
    check(!foreignIds.has(B.techB.toHexString()), "query-string technicianId is ignored (ownership still enforced)");

    console.log("\n[entry payloads]");
    const byId = new Map(items.map((entry) => [entry.bookingId, entry]));
    const unpaidEntry = byId.get(B.unpaidNoPayment.toHexString());
    check(unpaidEntry?.status === "unpaid" && unpaidEntry?.amount === 150, `unpaid entry ${JSON.stringify({ status: unpaidEntry?.status, amount: unpaidEntry?.amount })} (expected unpaid/150)`);
    check(unpaidEntry?.reference === null, "unpaid entry carries no reference");

    const paidEntry = byId.get(B.paidWithPayment.toHexString());
    check(paidEntry?.status === "paid" && paidEntry?.amount === 200 && paidEntry?.amountMinor === 20000, `paid entry amount ${paidEntry?.amount} (expected 200)`);
    check(typeof paidEntry?.reference === "string" && paidEntry.reference.startsWith("cs_test_techpay_"), "paid entry exposes the session reference");
    check(typeof paidEntry?.paidAt === "string" && paidEntry.paidAt.length > 0, "paid entry exposes paidAt");

    const paymentWins = byId.get(B.paidPaymentWins.toHexString());
    check(paymentWins?.amount === 65 && paymentWins?.amountMinor === 6500, `payment record wins over booking snapshot (got ${paymentWins?.amount})`);

    const anomaly = byId.get(B.paidNoPaymentAnomaly.toHexString());
    check(anomaly?.amount === 90 && anomaly?.reference === null, `paid booking without payment still counts once via finalAmount (got ${anomaly?.amount})`);

    const pendingEntry = byId.get(B.unpaidPending.toHexString());
    check(pendingEntry?.status === "unpaid" && pendingEntry?.amount === 80, `pending checkout surfaces as unpaid ${pendingEntry?.amount}`);

    const serialized = JSON.stringify(res.body);
    check(!serialized.includes("secret-checkout-url") && !serialized.includes("checkoutUrl"), "checkoutUrl never exposed");
    check(!serialized.includes("stripePaymentIntentId") && !serialized.includes("pi_test"), "payment intent id never exposed");
    check(!serialized.includes("seeded.customer@example.com") && !serialized.includes("customerEmail"), "customer email never exposed");

    console.log("\n[summary totals]");
    const summary = res.body?.summary ?? {};
    check(summary.totalCompletedBookings === 5, `totalCompletedBookings ${summary.totalCompletedBookings} (expected 5)`);
    check(summary.paidCount === 3, `paidCount ${summary.paidCount} (expected 3)`);
    check(summary.unpaidCount === 2, `unpaidCount ${summary.unpaidCount} (expected 2)`);
    const paidUsd = (summary.paidAmountByCurrency ?? []).find((entry) => entry.currency === "usd");
    check(paidUsd?.amount === 355, `paid usd total ${paidUsd?.amount} (expected 355 = 200 + 65 + 90)`);
    const unpaidUsd = (summary.unpaidAmountByCurrency ?? []).find((entry) => entry.currency === "usd");
    check(unpaidUsd?.amount === 230, `unpaid usd total ${unpaidUsd?.amount} (expected 230 = 150 + 80)`);

    console.log("\n[filtering and pagination]");
    const paidOnly = await api("/api/payments/technician?status=paid", { headers: auth(techA.token) });
    check(paidOnly.body?.data?.length === 3 && paidOnly.body?.data?.every((entry) => entry.status === "paid"), "status=paid returns exactly the 3 paid entries");
    check(paidOnly.body?.pagination?.totalItems === 3, `status=paid totalItems ${paidOnly.body?.pagination?.totalItems} (expected 3)`);
    check(paidOnly.body?.summary?.totalCompletedBookings === 5, "summary ignores the status filter");

    const unpaidOnly = await api("/api/payments/technician?status=unpaid", { headers: auth(techA.token) });
    check(unpaidOnly.body?.data?.length === 2 && unpaidOnly.body?.data?.every((entry) => entry.status === "unpaid"), "status=unpaid returns exactly the 2 unpaid entries");

    const page1 = await api("/api/payments/technician?limit=2&page=1", { headers: auth(techA.token) });
    check(page1.body?.data?.length === 2 && page1.body?.pagination?.totalPages === 3 && page1.body?.pagination?.hasNextPage === true && page1.body?.pagination?.hasPrevPage === false, "page 1 of 3 with limit=2");
    const page3 = await api("/api/payments/technician?limit=2&page=3", { headers: auth(techA.token) });
    check(page3.body?.data?.length === 1 && page3.body?.pagination?.hasNextPage === false && page3.body?.pagination?.hasPrevPage === true, "page 3 has the final entry");

    const limitTooBig = await api("/api/payments/technician?limit=51", { headers: auth(techA.token) });
    check(limitTooBig.status === 400, `limit=51 -> ${limitTooBig.status} (expected 400)`);
    const badStatus = await api("/api/payments/technician?status=whatever", { headers: auth(techA.token) });
    check(badStatus.status === 400, `status=whatever -> ${badStatus.status} (expected 400)`);
    const badPage = await api("/api/payments/technician?page=abc", { headers: auth(techA.token) });
    check(badPage.status === 400, `page=abc -> ${badPage.status} (expected 400)`);

    console.log("\n[technician B isolation]");
    const resB = await api("/api/payments/technician", { headers: auth(techB.token) });
    const itemsB = resB.body?.data ?? [];
    check(itemsB.length === 1 && itemsB[0]?.bookingId === B.techB.toHexString(), "technician B sees only their own booking");
    check(resB.body?.summary?.totalCompletedBookings === 1 && (resB.body?.summary?.paidAmountByCurrency ?? [])[0]?.amount === 400, "technician B summary scoped to their own work");
  } finally {
    await cleanup(db, { userIds, bookingIds, paymentIds });
    await client.close();
  }

  console.log(`\n${failures === 0 ? "TECHNICIAN-PAYMENTS CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("technician-payments test crashed:", error);
  process.exit(1);
});
