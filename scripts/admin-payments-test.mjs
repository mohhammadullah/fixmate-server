/**
 * FixMate admin payments integration test (development only).
 *
 * Verifies GET /api/admin/payments against a locally running server with a
 * real MongoDB database. Seeds six known payment records (three succeeded —
 * two USD, one EUR; one pending; one failed; one expired) plus two admin
 * accounts (normal + Main Admin), then exercises authorization, validation,
 * summary aggregation, filtering, search, DTO safety and pagination, and
 * confirms the endpoint is strictly read-only.
 *
 * Throwaway users and payments are created and removed on completion.
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/admin-payments-test.mjs
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
const info = (msg) => console.log(`  INFO  ${msg}`);
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

const makeUser = async (db, label, role = "customer", applicationStatus = null) => {
  const email = `fixmate.admin.payments.${label}.${Date.now()}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const name = label === "customer" ? "Seeded Payment SearchToken Customer" : `FixMate Payments ${label}`;
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST", headers,
    body: JSON.stringify({ email, password, name }),
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`signup ${label} failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  }
  if (role !== "customer" || applicationStatus) {
    const set = { role };
    if (applicationStatus) {
      set["technicianApplication.status"] = applicationStatus;
      set["technicianApplication.experience"] = 3;
      set["technicianApplication.skills"] = ["Repair"];
      set["technicianApplication.submittedAt"] = new Date();
    }
    await db.collection("user").updateOne({ email }, { $set: set });
  }
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST", headers, body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) throw new Error(`signin ${label} failed: ${signin.status}`);
  const cookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
  const tokenRes = await api("/api/auth/token", { headers: { cookie } });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") throw new Error(`token ${label} failed`);
  const user = await db.collection("user").findOne({ email });
  return { email, password, name, userId: user._id, token: tokenRes.body.token };
};

const main = async () => {
  console.log(`Admin payments test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const payments = db.collection("payments");

  // Self-heal: drop leftovers from crashed earlier runs of this test.
  await payments.deleteMany({ stripeSessionId: { $regex: /^cs_test_seed_/ } });

  const admin = await makeUser(db, "admin", "admin");
  const mainAdmin = await makeUser(db, "main", "admin");
  await users.updateOne({ _id: mainAdmin.userId }, { $set: { isMainAdmin: true } });
  const technician = await makeUser(db, "tech", "technician");
  const customer = await makeUser(db, "customer", "customer");
  console.log("throwaway users created: admin, mainAdmin, technician, customer\n");

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const seed = (index, overrides) => ({
    _id: new ObjectId(),
    // Each succeeded payment gets its own booking: the
    // payments_one_succeeded_per_booking_unique partial index forbids two
    // succeeded payments per booking.
    bookingId: new ObjectId(),
    customerId: customer.userId,
    technicianId: technician.userId,
    stripeSessionId: `cs_test_seed_${index}`,
    stripePaymentIntentId: `pi_test_seed_${index}`,
    amount: 1000,
    currency: "usd",
    status: "pending",
    createdAt: new Date(now - DAY * 2),
    updatedAt: new Date(now - DAY * 2),
    ...overrides,
  });

  const seedPayments = [
    seed("a", { amount: 5000, status: "succeeded", paidAt: new Date(now - DAY * 2), createdAt: new Date(now - DAY * 2) }),
    seed("b", { amount: 9999, status: "pending", createdAt: new Date(now - DAY * 2) }),
    seed("c", { amount: 2500, status: "succeeded", paidAt: new Date(now - DAY), createdAt: new Date(now - DAY) }),
    seed("d", { amount: 4000, status: "failed", createdAt: new Date(now - DAY), updatedAt: new Date(now - DAY) }),
    seed("e", { amount: 1500, currency: "eur", status: "succeeded", paidAt: new Date(now), createdAt: new Date(now) }),
    seed("f", { amount: 1500, status: "expired", createdAt: new Date(now), updatedAt: new Date(now) }),
  ];

  await payments.insertMany(seedPayments);
  const seedIds = seedPayments.map((payment) => payment._id);

  try {
    const adminToken = admin.token;
    const mainToken = mainAdmin.token;
    const technicianToken = technician.token;
    const customerToken = customer.token;

    // --- Authorization ---
    console.log("[authorization]");
    const anon = await api("/api/admin/payments");
    check(anon.status === 401, `anonymous -> ${anon.status} (expected 401)`);
    const customerRes = await api("/api/admin/payments", { headers: auth(customerToken) });
    check(customerRes.status === 403, `customer -> ${customerRes.status} (expected 403)`);
    const technicianRes = await api("/api/admin/payments", { headers: auth(technicianToken) });
    check(technicianRes.status === 403, `technician -> ${technicianRes.status} (expected 403)`);
    const normalAdmin = await api("/api/admin/payments", { headers: auth(adminToken) });
    check(normalAdmin.status === 200 && normalAdmin.body?.success === true, `normal admin -> ${normalAdmin.status} (expected 200)`);
    const mainAdminRes = await api("/api/admin/payments", { headers: auth(mainToken) });
    check(mainAdminRes.status === 200 && mainAdminRes.body?.success === true, `main admin -> ${mainAdminRes.status} (expected 200)`);

    // --- Validation ---
    console.log("\n[validation]");
    for (const [label, query] of [
      ["limit=51", "limit=51"],
      ["limit=abc", "limit=abc"],
      ["limit=0", "limit=0"],
      ["page=0", "page=0"],
      ["page=abc", "page=abc"],
      ["status=bogus", "status=bogus"],
      ["from=not-a-date", "from=not-a-date"],
      ["invalid calendar day", "from=2026-99-99"],
      ["from after to", "from=2026-12-31&to=2026-01-01"],
      ["huge search", `search=${"x".repeat(201)}`],
    ]) {
      const res = await api(`/api/admin/payments?${query}`, { headers: auth(adminToken) });
      check(res.status === 400, `query (${label}) -> ${res.status} (expected 400)`);
    }

    // --- Listing & DTO safety ---
    console.log("\n[listing]");
    const list = await api("/api/admin/payments", { headers: auth(adminToken) });
    check(list.status === 200 && Array.isArray(list.body?.data) && list.body.data.length === 6, `default listing returns all 6 seeded payments (got ${list.body?.data?.length ?? "no data"})`);
    const dto = list.body?.data?.[0] ?? {};
    for (const forbidden of ["_id", "checkoutUrl", "customerId", "technicianId", "password", "passwordHash"]) {
      check(!(forbidden in dto), `DTO excludes sensitive field '${forbidden}'`);
    }
    for (const required of ["id", "bookingId", "reference", "paymentIntentId", "amount", "currency", "status", "createdAt", "customerName", "customerEmail"]) {
      check(required in dto, `DTO includes '${required}'`);
    }
    check(dto.reference?.startsWith("cs_test_seed_"), "DTO exposes the Stripe checkout session id");
    check(dto.paymentIntentId?.startsWith("pi_test_seed_"), "DTO exposes the Stripe payment intent id");
    check(Math.abs(dto.amount - 15) < 1e-9 || Math.abs(dto.amount - 25) < 1e-9 || Math.abs(dto.amount - 50) < 1e-9, "amount is in major units");
    const createdAts = list.body.data.map((item) => new Date(item.createdAt).getTime());
    check(createdAts.every((t, i) => i === 0 || createdAts[i - 1] >= t), "payments are sorted newest first");

    // --- Summary aggregation ---
    console.log("\n[summary]");
    const summary = list.body?.summary ?? {};
    check(summary.successfulPayments === 3, `successfulPayments === 3 (got ${summary.successfulPayments})`);
    check(summary.pendingPayments === 1, `pendingPayments === 1 (got ${summary.pendingPayments})`);
    check(summary.failedPayments === 1, `failedPayments === 1 (got ${summary.failedPayments})`);
    check(summary.expiredPayments === 1, `expiredPayments === 1 (got ${summary.expiredPayments})`);
    const byCurrency = new Map((summary.successfulAmountByCurrency ?? []).map((entry) => [entry.currency, entry.amount]));
    check(Math.abs((byCurrency.get("usd") ?? -1) - 75) < 1e-9, `usd succeeded total === 75 (got ${byCurrency.get("usd")})`);
    check(Math.abs((byCurrency.get("eur") ?? -1) - 15) < 1e-9, `eur succeeded total === 15 (got ${byCurrency.get("eur")})`);

    // --- Status filter ---
    console.log("\n[status filter]");
    for (const [status, expected] of [["succeeded", 3], ["pending", 1], ["failed", 1], ["expired", 1]]) {
      const res = await api(`/api/admin/payments?status=${status}`, { headers: auth(adminToken) });
      const items = res.body?.data ?? [];
      check(
        res.status === 200 && items.length === expected && items.every((item) => item.status === status),
        `status=${status} -> ${items.length} item(s) (expected ${expected})`
      );
    }

    // --- Date range ---
    console.log("\n[date range]");
    const twoDaysAgo = new Date(now - DAY * 2).toISOString().slice(0, 10);
    const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    const range = await api(`/api/admin/payments?from=${yesterday}&to=${today}`, { headers: auth(adminToken) });
    check(range.status === 200 && range.body?.data?.length === 4, `date range excludes 2-day-old records -> ${range.body?.data?.length} item(s) (expected 4)`);
    const rangeSummary = range.body?.summary ?? {};
    check(rangeSummary.successfulPayments === 2, `date-scoped summary: 2 succeeded (got ${rangeSummary.successfulPayments})`);
    const scopedByCurrency = new Map((rangeSummary.successfulAmountByCurrency ?? []).map((entry) => [entry.currency, entry.amount]));
    check(Math.abs((scopedByCurrency.get("usd") ?? -1) - 25) < 1e-9 && Math.abs((scopedByCurrency.get("eur") ?? -1) - 15) < 1e-9, "date-scoped amounts per currency are correct");

    // --- Search ---
    console.log("\n[search]");
    const byEmail = await api(`/api/admin/payments?search=${encodeURIComponent(customer.email)}`, { headers: auth(adminToken) });
    check(byEmail.status === 200 && byEmail.body?.data?.length === 6, `search by customer email -> ${byEmail.body?.data?.length} item(s)`);
    const byName = await api(`/api/admin/payments?search=${encodeURIComponent("Payment SearchToken")}`, { headers: auth(adminToken) });
    check(byName.status === 200 && byName.body?.data?.length === 6, `search by customer name -> ${byName.body?.data?.length} item(s)`);
    const bySession = await api(`/api/admin/payments?search=cs_test_seed_a`, { headers: auth(adminToken) });
    check(bySession.status === 200 && bySession.body?.data?.length === 1, `search by stripe session -> ${bySession.body?.data?.length} item(s)`);
    const byPaymentIntent = await api(`/api/admin/payments?search=pi_test_seed_e`, { headers: auth(adminToken) });
    check(byPaymentIntent.status === 200 && byPaymentIntent.body?.data?.length === 1, `search by payment intent -> ${byPaymentIntent.body?.data?.length} item(s)`);
    const byBookingId = await api(`/api/admin/payments?search=${seedPayments[0].bookingId.toHexString()}`, { headers: auth(adminToken) });
    check(byBookingId.status === 200 && byBookingId.body?.data?.every((item) => item.bookingId === seedPayments[0].bookingId.toHexString()), "search by booking id finds the seeded booking's payment");
    const byPaymentId = await api(`/api/admin/payments?search=${seedPayments[0]._id.toHexString()}`, { headers: auth(adminToken) });
    check(byPaymentId.status === 200 && byPaymentId.body?.data?.length === 1, "search by payment id finds exactly one payment");
    const noMatch = await api(`/api/admin/payments?search=zzz_no_match_zzz`, { headers: auth(adminToken) });
    check(noMatch.status === 200 && noMatch.body?.data?.length === 0, "no-match search yields empty data");
    check(noMatch.body?.summary?.successfulPayments === 0, "empty results yield zeroed summary");
    check(noMatch.body?.pagination?.totalItems === 0, "empty results yield zero totalItems");

    // --- Pagination ---
    console.log("\n[pagination]");
    const limit2 = await api("/api/admin/payments?limit=2&page=1", { headers: auth(adminToken) });
    check(
      limit2.status === 200 && limit2.body?.data?.length === 2 &&
        limit2.body?.pagination?.totalItems === 6 &&
        limit2.body?.pagination?.totalPages === 3 &&
        limit2.body?.pagination?.hasNextPage === true,
      "limit=2 page=1 -> 2 items, totalItems=6, totalPages=3, hasNextPage=true"
    );
    const limit2Last = await api("/api/admin/payments?limit=2&page=3", { headers: auth(adminToken) });
    check(
      limit2Last.status === 200 && limit2Last.body?.data?.length === 2 &&
        limit2Last.body?.pagination?.hasNextPage === false &&
        limit2Last.body?.pagination?.currentPage === 3,
      "limit=2 page=3 -> last page with hasNextPage=false"
    );

    // --- Read-only: endpoint does not mutate the payments collection ---
    console.log("\n[read-only]");
    const statusCounts = await Promise.all(
      ["succeeded", "pending", "failed", "expired"].map((status) =>
        payments.countDocuments({ _id: { $in: seedIds }, status })
      )
    );
    check(
      statusCounts[0] === 3 && statusCounts[1] === 1 && statusCounts[2] === 1 && statusCounts[3] === 1,
      "payment statuses in the database are unchanged after listing/filtering/searching"
    );
  } finally {
    // --- Cleanup ---
    await payments.deleteMany({ _id: { $in: seedIds } });
    const throwawayIds = [admin.userId, mainAdmin.userId, technician.userId, customer.userId];
    await sessions.deleteMany({ userId: { $in: throwawayIds.map(String) } });
    await accounts.deleteMany({ userId: { $in: throwawayIds.map(String) } });
    await users.deleteMany({ _id: { $in: throwawayIds } });
    console.log("\ncleanup: seeded payments and throwaway users removed");
    await client.close();
  }

  console.log(`\n${failures === 0 ? "ADMIN PAYMENTS CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("admin payments test crashed:", e);
  try { await client.close(); } catch {}
  process.exit(1);
});
