/**
 * FixMate — admin dashboard revenue aggregation test (isolated app).
 *
 * Seeds only throwaway payment documents + one throwaway admin account and
 * removes them afterwards. Verifies settled revenue, currency grouping,
 * exclusion of non-settled payments, and refund handling.
 *
 * Usage: node scripts/with-isolated-app.mjs scripts/admin-revenue-test.mjs
 */
import "dotenv/config";
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

const jsonHeaders = (token) => ({
  "content-type": "application/json",
  origin: TEST_ORIGIN,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

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

const getJwt = async (cookie) => {
  const res = await api("/api/auth/token", { headers: { cookie } });
  if (res.status !== 200 || typeof res.body?.token !== "string") {
    throw new Error(`could not obtain JWT (${res.status})`);
  }
  return res.body.token;
};

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

const revenueMap = (body) => {
  const rows = Array.isArray(body?.data?.settledPaymentRevenue)
    ? body.data.settledPaymentRevenue
    : [];
  return new Map(
    rows.map((row) => [
      row.currency,
      {
        succeededPayments: row.succeededPayments,
        grossMinor: row.grossMinor,
        refundedMinor: row.refundedMinor,
        netMinor: row.netMinor,
      },
    ])
  );
};

const entry = (map, currency) =>
  map.get(currency) ?? { succeededPayments: 0, grossMinor: 0, refundedMinor: 0, netMinor: 0 };

const deltaMatches = (before, after, currency, expected) => {
  const a = entry(before, currency);
  const b = entry(after, currency);
  return ["succeededPayments", "grossMinor", "refundedMinor", "netMinor"].every(
    (key) => b[key] - a[key] === expected[key]
  );
};

const main = async () => {
  console.log(`Admin revenue test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const payments = db.collection("payments");

  const runId = Date.now();
  const email = `fixmate.revenue.admin.${runId}@example.com`;
  const password = `Revenue-${runId}-Aa1!`;
  const seededPaymentIds = [];

  try {
    console.log("[setup]");
    const signup = await api("/api/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password, name: "Revenue Test Admin" }),
    });
    if (signup.status !== 200 && signup.status !== 201) {
      throw new Error(`signup failed ${signup.status}`);
    }
    const signin = await api("/api/auth/sign-in/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const cookie = (signin.headers?.getSetCookie?.() ?? [])
      .find((entry) => entry.includes("session_token"))
      ?.split(";")[0];
    if (!cookie) throw new Error("no session cookie");
    const adminUser = await users.findOne({ email });
    await users.updateOne({ _id: adminUser._id }, { $set: { role: "admin" } });
    const token = await getJwt(cookie);

    const stats = () =>
      api("/api/admin/dashboard/stats", {
        headers: { authorization: `Bearer ${token}` },
      });

    const baselineResponse = await stats();
    check(baselineResponse.status === 200, `admin stats endpoint -> ${baselineResponse.status}`);
    const baseline = revenueMap(baselineResponse.body);
    console.log(`  baseline currencies: ${[...baseline.keys()].join(",") || "(none)"}`);

    const seedPayment = async ({ status, amount, currency, refunds = [] }) => {
      const _id = new ObjectId();
      await payments.insertOne({
        _id,
        bookingId: new ObjectId(),
        customerId: new ObjectId(),
        technicianId: new ObjectId(),
        amount,
        currency,
        status,
        refunds,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      seededPaymentIds.push(_id);
      return _id;
    };

    console.log("\n[non-settled payments ignored]");
    await seedPayment({ status: "pending", amount: 10000, currency: "usd" });
    await seedPayment({ status: "failed", amount: 5000, currency: "usd" });
    const afterPending = revenueMap((await stats()).body);
    check(
      deltaMatches(baseline, afterPending, "usd", {
        succeededPayments: 0,
        grossMinor: 0,
        refundedMinor: 0,
        netMinor: 0,
      }),
      "pending/failed payments do not change revenue"
    );

    console.log("\n[settled payments and refunds]");
    await seedPayment({ status: "succeeded", amount: 12000, currency: "usd" });
    await seedPayment({
      status: "succeeded",
      amount: 8000,
      currency: "usd",
      refunds: [
        {
          id: new ObjectId().toHexString(),
          amountMinor: 3000,
          currency: "usd",
          reason: "Completed refund",
          status: "succeeded",
          requestedAt: new Date(),
          idempotencyKey: `completed-${runId}`,
        },
        {
          id: new ObjectId().toHexString(),
          amountMinor: 2000,
          currency: "usd",
          reason: "Pending refund",
          status: "pending",
          requestedAt: new Date(),
          idempotencyKey: `pending-${runId}`,
        },
        {
          id: new ObjectId().toHexString(),
          amountMinor: 1000,
          currency: "usd",
          reason: "Rejected refund",
          status: "rejected",
          requestedAt: new Date(),
          idempotencyKey: `rejected-${runId}`,
        },
      ],
    });
    await seedPayment({ status: "succeeded", amount: 5000, currency: "bdt" });
    await seedPayment({ status: "succeeded", amount: 3000, currency: "jpy" });

    const finalResponse = await stats();
    const finalMap = revenueMap(finalResponse.body);
    check(
      deltaMatches(baseline, finalMap, "usd", {
        succeededPayments: 2,
        grossMinor: 20000,
        refundedMinor: 3000,
        netMinor: 17000,
      }),
      "USD: two settled payments, only completed refund subtracted"
    );
    check(
      deltaMatches(baseline, finalMap, "bdt", {
        succeededPayments: 1,
        grossMinor: 5000,
        refundedMinor: 0,
        netMinor: 5000,
      }),
      "BDT: separate currency total reported in minor units"
    );
    check(
      deltaMatches(baseline, finalMap, "jpy", {
        succeededPayments: 1,
        grossMinor: 3000,
        refundedMinor: 0,
        netMinor: 3000,
      }),
      "JPY: zero-decimal currency grouped independently"
    );
    check(
      !finalMap.has("usd") === false &&
        finalMap.get("usd").netMinor === entry(baseline, "usd").netMinor + 17000,
      "net revenue excludes pending/rejected refund amounts"
    );

    const serialized = JSON.stringify(finalResponse.body);
    const leaked = ["customerEmail", "stripeSessionId", "stripePaymentIntentId", "sk_live_", "whsec_"]
      .filter((needle) => serialized.includes(needle));
    check(leaked.length === 0, `stats response has no sensitive fields -> leaked: ${leaked.join(",") || "none"}`);
  } finally {
    console.log("\n[cleanup]");
    await payments.deleteMany({ _id: { $in: seededPaymentIds } });
    const user = await users.findOne({ email });
    if (user) {
      await sessions.deleteMany({ userId: user._id });
      await accounts.deleteMany({ userId: user._id });
      await users.deleteOne({ _id: user._id });
    }
    await client.close();
    console.log("  cleanup done");
  }

  console.log(`\n${failures === 0 ? "ADMIN REVENUE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("admin revenue test crashed:", error);
  process.exit(1);
});
