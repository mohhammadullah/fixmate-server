/**
 * FixMate admin payments integration test (development only, isolated).
 *
 * Verifies GET /api/admin/payments against an isolated throwaway API server
 * and a temporary MongoDB database. Seeds six known payment records (three
 * succeeded — two USD, one EUR; one pending; one failed; one expired) plus
 * throwaway admin/customer/technician accounts, then exercises authorization,
 * validation, summary aggregation, filtering, search, DTO safety and
 * pagination, and confirms the endpoint is strictly read-only.
 *
 * Isolation: uses its own ephemeral-port app instance and a temporary database
 * that is dropped on completion. No shared development records are deleted or
 * modified and no production data is touched.
 *
 * Required env: MONGODB_URI (from .env).
 * Optional env: MONGODB_DB_NAME (base name; temp DB derives from it), TEST_ORIGIN.
 * Usage: node scripts/admin-payments-test.mjs
 */
import "dotenv/config";
import http from "node:http";
import net from "node:net";
import { MongoClient, ObjectId } from "mongodb";

const TEST_ORIGIN = process.env.TEST_ORIGIN ?? "http://localhost:3000";
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const tempDbName = `fm_ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Must be set before importing dist env/db modules.
process.env.MONGODB_DB_NAME = tempDbName;
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:65535";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_mock_placeholder";
process.env.STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_mock_test_secret_0123456789";
process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";

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

const jsonHeaders = (token) => ({
  "content-type": "application/json",
  origin: TEST_ORIGIN,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI must be set (via .env).");
    process.exit(1);
  }

  const appPort = await getFreePort();
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${appPort}`;
  const APP_BASE = `http://127.0.0.1:${appPort}`;

  console.log(
    `Admin payments isolated test (API :${appPort}, temp DB ${tempDbName})\n`
  );

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

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const db = client.db(tempDbName);
  const users = db.collection("user");
  const payments = db.collection("payments");

  const makeUser = async (label, role = "customer") => {
    const email = `fixmate.admin.payments.${label}.${runId}@example.com`;
    const password = crypto.randomUUID() + "Aa1!";
    const name =
      label === "customer" ? "Seeded Payment SearchToken Customer" : `FixMate Payments ${label}`;
    const signup = await api(APP_BASE, "/api/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password, name }),
    });
    if (signup.status !== 200 && signup.status !== 201) {
      throw new Error(`signup ${label} failed: ${signup.status} ${JSON.stringify(signup.body)}`);
    }
    if (role !== "customer") {
      await users.updateOne({ email }, { $set: { role } });
    }
    const signin = await api(APP_BASE, "/api/auth/sign-in/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password }),
    });
    if (signin.status !== 200) throw new Error(`signin ${label} failed: ${signin.status}`);
    const cookie = (signin.headers.getSetCookie?.() ?? [])
      .find((c) => c.includes("session_token"))
      ?.split(";")[0];
    const tokenRes = await api(APP_BASE, "/api/auth/token", { headers: { cookie } });
    if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
      throw new Error(`token ${label} failed`);
    }
    const user = await users.findOne({ email });
    return { email, password, name, userId: user._id, token: tokenRes.body.token };
  };

  let tempDbDropped = false;
  try {
    const admin = await makeUser("admin", "admin");
    const mainAdmin = await makeUser("main", "admin");
    await users.updateOne({ _id: mainAdmin.userId }, { $set: { isMainAdmin: true } });
    const technician = await makeUser("tech", "technician");
    const customer = await makeUser("customer", "customer");
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

    const adminToken = admin.token;
    const mainToken = mainAdmin.token;
    const technicianToken = technician.token;
    const customerToken = customer.token;

    // --- Authorization ---
    console.log("[authorization]");
    const anon = await api(APP_BASE, "/api/admin/payments");
    check(anon.status === 401, `anonymous -> ${anon.status} (expected 401)`);
    const customerRes = await api(APP_BASE, "/api/admin/payments", {
      headers: jsonHeaders(customerToken),
    });
    check(customerRes.status === 403, `customer -> ${customerRes.status} (expected 403)`);
    const technicianRes = await api(APP_BASE, "/api/admin/payments", {
      headers: jsonHeaders(technicianToken),
    });
    check(technicianRes.status === 403, `technician -> ${technicianRes.status} (expected 403)`);
    const normalAdmin = await api(APP_BASE, "/api/admin/payments", {
      headers: jsonHeaders(adminToken),
    });
    check(
      normalAdmin.status === 200 && normalAdmin.body?.success === true,
      `normal admin -> ${normalAdmin.status} (expected 200)`
    );
    const mainAdminRes = await api(APP_BASE, "/api/admin/payments", {
      headers: jsonHeaders(mainToken),
    });
    check(
      mainAdminRes.status === 200 && mainAdminRes.body?.success === true,
      `main admin -> ${mainAdminRes.status} (expected 200)`
    );

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
      const res = await api(APP_BASE, `/api/admin/payments?${query}`, {
        headers: jsonHeaders(adminToken),
      });
      check(res.status === 400, `query (${label}) -> ${res.status} (expected 400)`);
    }

    // --- Listing & DTO safety ---
    console.log("\n[listing]");
    const list = await api(APP_BASE, "/api/admin/payments", { headers: jsonHeaders(adminToken) });
    check(
      list.status === 200 && Array.isArray(list.body?.data) && list.body.data.length === 6,
      `default listing returns all 6 seeded payments (got ${list.body?.data?.length ?? "no data"})`
    );
    const dto = list.body?.data?.[0] ?? {};
    for (const forbidden of [
      "_id",
      "checkoutUrl",
      "customerId",
      "technicianId",
      "password",
      "passwordHash",
    ]) {
      check(!(forbidden in dto), `DTO excludes sensitive field '${forbidden}'`);
    }
    for (const required of [
      "id",
      "bookingId",
      "reference",
      "paymentIntentId",
      "amount",
      "currency",
      "status",
      "createdAt",
      "customerName",
      "customerEmail",
    ]) {
      check(required in dto, `DTO includes '${required}'`);
    }
    check(dto.reference?.startsWith("cs_test_seed_"), "DTO exposes the Stripe checkout session id");
    check(
      dto.paymentIntentId?.startsWith("pi_test_seed_"),
      "DTO exposes the Stripe payment intent id"
    );
    check(
      Math.abs(dto.amount - 15) < 1e-9 ||
        Math.abs(dto.amount - 25) < 1e-9 ||
        Math.abs(dto.amount - 50) < 1e-9,
      "amount is in major units"
    );
    const createdAts = list.body.data.map((item) => new Date(item.createdAt).getTime());
    check(
      createdAts.every((t, i) => i === 0 || createdAts[i - 1] >= t),
      "payments are sorted newest first"
    );

    // --- Summary aggregation ---
    console.log("\n[summary]");
    const summary = list.body?.summary ?? {};
    check(
      summary.successfulPayments === 3,
      `successfulPayments === 3 (got ${summary.successfulPayments})`
    );
    check(summary.pendingPayments === 1, `pendingPayments === 1 (got ${summary.pendingPayments})`);
    check(summary.failedPayments === 1, `failedPayments === 1 (got ${summary.failedPayments})`);
    check(summary.expiredPayments === 1, `expiredPayments === 1 (got ${summary.expiredPayments})`);
    const byCurrency = new Map(
      (summary.successfulAmountByCurrency ?? []).map((entry) => [entry.currency, entry.amount])
    );
    check(
      Math.abs((byCurrency.get("usd") ?? -1) - 75) < 1e-9,
      `usd succeeded total === 75 (got ${byCurrency.get("usd")})`
    );
    check(
      Math.abs((byCurrency.get("eur") ?? -1) - 15) < 1e-9,
      `eur succeeded total === 15 (got ${byCurrency.get("eur")})`
    );

    // --- Status filter ---
    console.log("\n[status filter]");
    for (const [status, expected] of [
      ["succeeded", 3],
      ["pending", 1],
      ["failed", 1],
      ["expired", 1],
    ]) {
      const res = await api(APP_BASE, `/api/admin/payments?status=${status}`, {
        headers: jsonHeaders(adminToken),
      });
      const items = res.body?.data ?? [];
      check(
        res.status === 200 &&
          items.length === expected &&
          items.every((item) => item.status === status),
        `status=${status} -> ${items.length} item(s) (expected ${expected})`
      );
    }

    // --- Date range ---
    console.log("\n[date range]");
    const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    const range = await api(APP_BASE, `/api/admin/payments?from=${yesterday}&to=${today}`, {
      headers: jsonHeaders(adminToken),
    });
    check(
      range.status === 200 && range.body?.data?.length === 4,
      `date range excludes 2-day-old records -> ${range.body?.data?.length} item(s) (expected 4)`
    );
    const rangeSummary = range.body?.summary ?? {};
    check(
      rangeSummary.successfulPayments === 2,
      `date-scoped summary: 2 succeeded (got ${rangeSummary.successfulPayments})`
    );
    const scopedByCurrency = new Map(
      (rangeSummary.successfulAmountByCurrency ?? []).map((entry) => [entry.currency, entry.amount])
    );
    check(
      Math.abs((scopedByCurrency.get("usd") ?? -1) - 25) < 1e-9 &&
        Math.abs((scopedByCurrency.get("eur") ?? -1) - 15) < 1e-9,
      "date-scoped amounts per currency are correct"
    );

    // --- Search ---
    console.log("\n[search]");
    const byEmail = await api(
      APP_BASE,
      `/api/admin/payments?search=${encodeURIComponent(customer.email)}`,
      { headers: jsonHeaders(adminToken) }
    );
    check(
      byEmail.status === 200 && byEmail.body?.data?.length === 6,
      `search by customer email -> ${byEmail.body?.data?.length} item(s)`
    );
    const byName = await api(
      APP_BASE,
      `/api/admin/payments?search=${encodeURIComponent("Payment SearchToken")}`,
      { headers: jsonHeaders(adminToken) }
    );
    check(
      byName.status === 200 && byName.body?.data?.length === 6,
      `search by customer name -> ${byName.body?.data?.length} item(s)`
    );
    const bySession = await api(APP_BASE, `/api/admin/payments?search=cs_test_seed_a`, {
      headers: jsonHeaders(adminToken),
    });
    check(
      bySession.status === 200 && bySession.body?.data?.length === 1,
      `search by stripe session -> ${bySession.body?.data?.length} item(s)`
    );
    const byPaymentIntent = await api(APP_BASE, `/api/admin/payments?search=pi_test_seed_e`, {
      headers: jsonHeaders(adminToken),
    });
    check(
      byPaymentIntent.status === 200 && byPaymentIntent.body?.data?.length === 1,
      `search by payment intent -> ${byPaymentIntent.body?.data?.length} item(s)`
    );
    const byBookingId = await api(
      APP_BASE,
      `/api/admin/payments?search=${seedPayments[0].bookingId.toHexString()}`,
      { headers: jsonHeaders(adminToken) }
    );
    check(
      byBookingId.status === 200 &&
        byBookingId.body?.data?.every(
          (item) => item.bookingId === seedPayments[0].bookingId.toHexString()
        ),
      "search by booking id finds the seeded booking's payment"
    );
    const byPaymentId = await api(
      APP_BASE,
      `/api/admin/payments?search=${seedPayments[0]._id.toHexString()}`,
      { headers: jsonHeaders(adminToken) }
    );
    check(
      byPaymentId.status === 200 && byPaymentId.body?.data?.length === 1,
      "search by payment id finds exactly one payment"
    );
    const noMatch = await api(APP_BASE, `/api/admin/payments?search=zzz_no_match_zzz`, {
      headers: jsonHeaders(adminToken),
    });
    check(noMatch.status === 200 && noMatch.body?.data?.length === 0, "no-match search yields empty data");
    check(noMatch.body?.summary?.successfulPayments === 0, "empty results yield zeroed summary");
    check(noMatch.body?.pagination?.totalItems === 0, "empty results yield zero totalItems");

    // --- Pagination ---
    console.log("\n[pagination]");
    const limit2 = await api(APP_BASE, "/api/admin/payments?limit=2&page=1", {
      headers: jsonHeaders(adminToken),
    });
    check(
      limit2.status === 200 &&
        limit2.body?.data?.length === 2 &&
        limit2.body?.pagination?.totalItems === 6 &&
        limit2.body?.pagination?.totalPages === 3 &&
        limit2.body?.pagination?.hasNextPage === true,
      "limit=2 page=1 -> 2 items, totalItems=6, totalPages=3, hasNextPage=true"
    );
    const limit2Last = await api(APP_BASE, "/api/admin/payments?limit=2&page=3", {
      headers: jsonHeaders(adminToken),
    });
    check(
      limit2Last.status === 200 &&
        limit2Last.body?.data?.length === 2 &&
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
      statusCounts[0] === 3 &&
        statusCounts[1] === 1 &&
        statusCounts[2] === 1 &&
        statusCounts[3] === 1,
      "payment statuses in the database are unchanged after listing/filtering/searching"
    );
  } finally {
    console.log("\n[cleanup]");
    try {
      await db.dropDatabase();
      tempDbDropped = true;
      console.log(`  dropped temp DB ${tempDbName}`);
    } catch (e) {
      console.error(`  failed to drop temp DB ${tempDbName}:`, e);
    }
    await client.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    await closeDB().catch(() => undefined);
    console.log(
      `  cleanup ${tempDbDropped ? "complete (temp DB dropped)" : "incomplete (temp DB NOT dropped)"}`
    );
  }

  console.log(
    `\n${failures === 0 ? "ADMIN PAYMENTS CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`
  );
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("admin payments test crashed:", error);
  process.exit(1);
});
