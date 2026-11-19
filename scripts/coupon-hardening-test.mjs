/**
 * FixMate — coupon hardening edge-case test (development only).
 *
 * Self-contained: boots its own API copy on an ephemeral port with a mock
 * Stripe HTTP API and a temporary throwaway MongoDB database. Seeds only
 * throwaway records and drops the temporary database on completion.
 *
 * Covers: valid create/partial update, unsupported-field/empty update
 * rejection, invalid calendar date (2026-02-31), invalid date format,
 * expiry<start rejection, valid expiry, usage release at zero/positive,
 * concurrent releases (no < 0 / no lost updates), and existing coupon
 * redemption + payment behavior (preview + discounted checkout).
 *
 * Required env: MONGODB_URI (from .env).
 * Optional env: MONGODB_DB_NAME (base name; temp DB derives from it), TEST_ORIGIN.
 * Usage: node scripts/coupon-hardening-test.mjs
 */
import "dotenv/config";
import http from "node:http";
import net from "node:net";
import { MongoClient, ObjectId } from "mongodb";

const TEST_ORIGIN = process.env.TEST_ORIGIN ?? "http://localhost:3000";
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const tempDbName = `fm_ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Must be set before importing dist env/db modules.
process.env.MONGODB_DB_NAME = tempDbName;
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
  if (signin.status !== 200) {
    throw new Error(`signin failed ${signin.status}: ${JSON.stringify(signin.body)}`);
  }
  const setCookie = signin.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.includes("session_token"))?.split(";")[0];
  if (!sessionCookie) throw new Error("no session cookie from signin");
  return { cookie: sessionCookie, token: await getJwt(base, sessionCookie) };
};

const isoDaysFromNow = (days) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const main = async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI must be set (via .env).");
    process.exit(1);
  }

  const appPort = await getFreePort();
  const mockPort = await getFreePort();
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${appPort}`;
  const APP_BASE = `http://127.0.0.1:${appPort}`;

  console.log(
    `Coupon hardening test (API :${appPort}, mock Stripe :${mockPort}, temp DB ${tempDbName})\n`
  );

  // Mock Stripe (for checkout redemption behavior check).
  let checkoutCalls = 0;
  const mockStripe = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock");
      if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        checkoutCalls += 1;
        const params = new URLSearchParams(body);
        const id = `cs_coupon_mock_${checkoutCalls}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "checkout.session",
            status: "open",
            mode: "payment",
            amount_total: Number(params.get("line_items[0][price_data][unit_amount]")),
            currency: (params.get("currency") ?? "usd").toLowerCase(),
            url: `https://checkout.stripe.test/pay/${id}`,
            expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
            payment_status: "unpaid",
            metadata: {},
            client_reference_id: params.get("client_reference_id"),
            success_url: params.get("success_url"),
            cancel_url: params.get("cancel_url"),
          })
        );
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

  const { connectDB, closeDB, getDB } = await import("../dist/config/db.js");
  const { ensureIndexes } = await import("../dist/config/indexes.js");
  const { createAuth } = await import("../dist/config/auth.js");
  const { createApp } = await import("../dist/app.js");
  const { releaseCouponUsageSlot } = await import(
    "../dist/controllers/coupon.controller.js"
  );

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

  let tempDbDropped = false;
  const EMAIL_ADMIN = `fixmate.coupon.admin.${runId}@example.com`;
  const EMAIL_CUSTOMER = `fixmate.coupon.customer.${runId}@example.com`;
  const PASSWORD = `Coupon-Test-${runId}-Aa1!`;

  try {
    console.log("[setup]");
    const admin = await signUpAndSignIn(APP_BASE, EMAIL_ADMIN, PASSWORD, "Coupon Admin");
    const customer = await signUpAndSignIn(
      APP_BASE,
      EMAIL_CUSTOMER,
      PASSWORD,
      "Coupon Customer"
    );
    const adminUser = await users.findOne({ email: EMAIL_ADMIN });
    const customerUser = await users.findOne({ email: EMAIL_CUSTOMER });
    if (!adminUser || !customerUser) throw new Error("failed to seed test users");
    await users.updateOne(
      { _id: adminUser._id },
      { $set: { role: "admin", isMainAdmin: true } }
    );
    const adminToken = admin.token;
    const customerToken = customer.token;
    console.log("  seeded throwaway main admin and customer in temp DB");

    const couponsPath = "/api/admin/coupons";

    // 1. Valid coupon creation.
    console.log("\n[create]");
    const validCode = `VALID${runId.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "A")}`;
    const created = await api(APP_BASE, couponsPath, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        code: validCode,
        kind: "percent",
        value: 10,
        minBookingAmount: 10,
        perCustomerLimit: 1,
        globalLimit: 5,
        startsAt: isoDaysFromNow(-1),
        expiresAt: isoDaysFromNow(30),
      }),
    });
    check(
      created.status === 201 && created.body?.data?.code === validCode,
      `valid coupon creation -> ${created.status} ${JSON.stringify(created.body?.data?.code ?? created.body)}`
    );
    check(
      created.body?.data?.usageCount === 0 && created.body?.data?.active === true,
      `created coupon defaults usageCount=0, active=true`
    );

    // 2. Valid partial coupon update.
    console.log("\n[update valid]");
    const upd = await api(APP_BASE, `${couponsPath}/${validCode}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({ perCustomerLimit: 2 }),
    });
    check(upd.status === 200, `valid partial update (perCustomerLimit) -> ${upd.status}`);
    const listed = await api(APP_BASE, couponsPath, { headers: jsonHeaders(adminToken) });
    const listedCoupon = (listed.body?.data ?? []).find((c) => c.code === validCode);
    check(
      listedCoupon?.perCustomerLimit === 2,
      `updated perCustomerLimit persisted -> ${listedCoupon?.perCustomerLimit}`
    );

    // 3. Invalid partial update with unsupported fields.
    console.log("\n[update invalid unsupported fields]");
    const unsupported = await api(APP_BASE, `${couponsPath}/${validCode}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({ kind: "fixed", value: 5 }),
    });
    check(
      unsupported.status === 400 && unsupported.body?.message === "Validation failed.",
      `unsupported fields rejected -> ${unsupported.status} ${JSON.stringify(unsupported.body?.message)}`
    );
    const unknownField = await api(APP_BASE, `${couponsPath}/${validCode}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({ active: false, foo: "bar" }),
    });
    check(
      unknownField.status === 400,
      `unknown field rejected -> ${unknownField.status}`
    );

    // 4. Empty partial update rejection.
    console.log("\n[update empty]");
    const emptyUpd = await api(APP_BASE, `${couponsPath}/${validCode}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({}),
    });
    check(
      emptyUpd.status === 400 && emptyUpd.body?.message === "Validation failed.",
      `empty partial update rejected -> ${emptyUpd.status} ${JSON.stringify(emptyUpd.body?.message)}`
    );

    // 5. Invalid date: 2026-02-31.
    console.log("\n[invalid dates]");
    const badCal = await api(APP_BASE, couponsPath, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        code: `BADFEB${runId.slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, "B")}`,
        kind: "fixed",
        value: 5,
        expiresAt: "2026-02-31T00:00:00.000Z",
        startsAt: "2026-02-01T00:00:00.000Z",
      }),
    });
    check(
      badCal.status === 400,
      `invalid calendar date 2026-02-31 rejected -> ${badCal.status} ${JSON.stringify(badCal.body)}`
    );

    // 6. Invalid date format rejection.
    const badFmt1 = await api(APP_BASE, couponsPath, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        code: `BADFMT${runId.slice(-3).toUpperCase().replace(/[^A-Z0-9]/g, "C")}`,
        kind: "fixed",
        value: 5,
        expiresAt: "31-12-2027",
      }),
    });
    check(badFmt1.status === 400, `invalid date format (DD-MM-YYYY) rejected -> ${badFmt1.status}`);
    const badFmt2 = await api(APP_BASE, couponsPath, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        code: `BADFM2${runId.slice(-3).toUpperCase().replace(/[^A-Z0-9]/g, "D")}`,
        kind: "fixed",
        value: 5,
        expiresAt: "2027/12/31",
      }),
    });
    check(badFmt2.status === 400, `invalid date format (slashes) rejected -> ${badFmt2.status}`);
    const badFmt3 = await api(APP_BASE, couponsPath, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        code: `BADFM3${runId.slice(-3).toUpperCase().replace(/[^A-Z0-9]/g, "E")}`,
        kind: "fixed",
        value: 5,
        expiresAt: "not-a-date",
      }),
    });
    check(badFmt3.status === 400, `invalid date format (non-date) rejected -> ${badFmt3.status}`);

    // 7. Expiry earlier than start date rejection.
    console.log("\n[expiry vs start]");
    const expiryBeforeStart = await api(APP_BASE, couponsPath, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        code: `BADORD${runId.slice(-3).toUpperCase().replace(/[^A-Z0-9]/g, "F")}`,
        kind: "fixed",
        value: 5,
        startsAt: "2027-06-10T00:00:00.000Z",
        expiresAt: "2027-06-09T00:00:00.000Z",
      }),
    });
    check(
      expiryBeforeStart.status === 400,
      `expiry earlier than start rejected on create -> ${expiryBeforeStart.status} ${JSON.stringify(expiryBeforeStart.body)}`
    );

    // 8. Valid expiry after start date.
    const validExpiryCode = `GOODEX${runId.slice(-3).toUpperCase().replace(/[^A-Z0-9]/g, "G")}`;
    const validExpiry = await api(APP_BASE, couponsPath, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        code: validExpiryCode,
        kind: "fixed",
        value: 5,
        currency: "usd",
        startsAt: "2027-06-10T00:00:00.000Z",
        expiresAt: "2027-06-11T00:00:00.000Z",
      }),
    });
    check(
      validExpiry.status === 201,
      `valid expiry after start accepted -> ${validExpiry.status} ${JSON.stringify(validExpiry.body)}`
    );
    // Update path: setting expiresAt before existing startsAt must be rejected.
    const badUpdateExpiry = await api(APP_BASE, `${couponsPath}/${validCode}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({ expiresAt: "2000-01-01T00:00:00.000Z" }),
    });
    check(
      badUpdateExpiry.status === 400 && /expiresAt must be after startsAt/i.test(badUpdateExpiry.body?.message ?? ""),
      `update rejects expiresAt before existing startsAt -> ${badUpdateExpiry.status} ${JSON.stringify(badUpdateExpiry.body)}`
    );
    const goodUpdateExpiry = await api(APP_BASE, `${couponsPath}/${validCode}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({ expiresAt: isoDaysFromNow(60) }),
    });
    check(goodUpdateExpiry.status === 200, `valid expiry update accepted -> ${goodUpdateExpiry.status}`);

    // Helper: read usageCount for a coupon from temp DB (test-owned main admin).
    const readUsage = async (code) => {
      const doc = await users.findOne(
        { _id: adminUser._id, "adminConfig.coupons.code": code },
        { projection: { "adminConfig.coupons.$": 1 } }
      );
      return doc?.adminConfig?.coupons?.[0]?.usageCount;
    };

    // 9. Usage release when usageCount is zero.
    console.log("\n[usage release]");
    const relZeroCode = `REL0${runId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, "H")}`;
    await users.updateOne(
      { _id: adminUser._id },
      {
        $push: {
          "adminConfig.coupons": {
            code: relZeroCode,
            kind: "fixed",
            value: 5,
            minBookingAmount: 0,
            startsAt: new Date(Date.now() - 86400000),
            expiresAt: new Date(Date.now() + 30 * 86400000),
            perCustomerLimit: 1,
            active: true,
            usageCount: 0,
            createdAt: new Date(),
          },
        },
      }
    );
    await releaseCouponUsageSlot(relZeroCode);
    check((await readUsage(relZeroCode)) === 0, `release at usageCount 0 keeps count at 0`);

    // 10. Usage release when usageCount is positive.
    const relPosCode = `REL1${runId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, "J")}`;
    await users.updateOne(
      { _id: adminUser._id },
      {
        $push: {
          "adminConfig.coupons": {
            code: relPosCode,
            kind: "fixed",
            value: 5,
            minBookingAmount: 0,
            startsAt: new Date(Date.now() - 86400000),
            expiresAt: new Date(Date.now() + 30 * 86400000),
            perCustomerLimit: 5,
            active: true,
            usageCount: 3,
            createdAt: new Date(),
          },
        },
      }
    );
    await releaseCouponUsageSlot(relPosCode);
    check((await readUsage(relPosCode)) === 2, `release at usageCount 3 decrements to 2`);

    // 11. Concurrent releases: no decrement below zero, no lost updates.
    console.log("\n[concurrent usage release]");
    const concZeroCode = `CON0${runId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, "K")}`;
    await users.updateOne(
      { _id: adminUser._id },
      {
        $push: {
          "adminConfig.coupons": {
            code: concZeroCode,
            kind: "fixed",
            value: 5,
            minBookingAmount: 0,
            startsAt: new Date(Date.now() - 86400000),
            expiresAt: new Date(Date.now() + 30 * 86400000),
            perCustomerLimit: 10,
            globalLimit: 10,
            active: true,
            usageCount: 1,
            createdAt: new Date(),
          },
        },
      }
    );
    await Promise.all(Array.from({ length: 8 }, () => releaseCouponUsageSlot(concZeroCode)));
    const afterConcZero = await readUsage(concZeroCode);
    check(afterConcZero === 0, `concurrent releases from 1 never go below 0 -> ${afterConcZero}`);

    const concManyCode = `CONM${runId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, "L")}`;
    await users.updateOne(
      { _id: adminUser._id },
      {
        $push: {
          "adminConfig.coupons": {
            code: concManyCode,
            kind: "fixed",
            value: 5,
            minBookingAmount: 0,
            startsAt: new Date(Date.now() - 86400000),
            expiresAt: new Date(Date.now() + 30 * 86400000),
            perCustomerLimit: 10,
            globalLimit: 10,
            active: true,
            usageCount: 5,
            createdAt: new Date(),
          },
        },
      }
    );
    await Promise.all(Array.from({ length: 3 }, () => releaseCouponUsageSlot(concManyCode)));
    const afterConcMany = await readUsage(concManyCode);
    check(afterConcMany === 2, `3 concurrent releases from 5 decrement to 2 (no lost updates) -> ${afterConcMany}`);

    const concExactCode = `CONX${runId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, "M")}`;
    await users.updateOne(
      { _id: adminUser._id },
      {
        $push: {
          "adminConfig.coupons": {
            code: concExactCode,
            kind: "fixed",
            value: 5,
            minBookingAmount: 0,
            startsAt: new Date(Date.now() - 86400000),
            expiresAt: new Date(Date.now() + 30 * 86400000),
            perCustomerLimit: 10,
            globalLimit: 10,
            active: true,
            usageCount: 4,
            createdAt: new Date(),
          },
        },
      }
    );
    await Promise.all(Array.from({ length: 4 }, () => releaseCouponUsageSlot(concExactCode)));
    const afterConcExact = await readUsage(concExactCode);
    check(afterConcExact === 0, `4 concurrent releases from 4 reach 0 (no lost updates) -> ${afterConcExact}`);

    // 12. Existing coupon redemption and payment behavior remains correct.
    console.log("\n[redemption and payment behavior]");
    // Seed a completed, unpaid booking for the throwaway customer.
    const services = db.collection("services");
    const bookings = db.collection("bookings");
    const payments = db.collection("payments");
    const serviceId = new ObjectId();
    const now = new Date();
    await services.insertOne({
      _id: serviceId,
      title: `Coupon Test Service ${runId}`,
      category: "AC Repair",
      description: "Seeded service for coupon hardening redemption test.",
      overview: "Seeded overview for coupon hardening redemption test.",
      hourlyRate: 50,
      securityDeposit: 25,
      maxCapacity: 3,
      location: "Khulna",
      image: "https://example.com/coupon.jpg",
      amenities: ["Seeded amenity"],
      technicianId: adminUser._id, // arbitrary throwaway technician-like owner in temp DB
      technicianName: "Coupon Admin",
      technicianEmail: EMAIL_ADMIN,
      approvalStatus: "approved",
      availabilityStatus: "available",
      createdAt: now,
      updatedAt: now,
    });
    const bookingId = new ObjectId();
    await bookings.insertOne({
      _id: bookingId,
      serviceId,
      customerId: customerUser._id,
      technicianId: adminUser._id,
      customerName: "Coupon Customer",
      customerEmail: EMAIL_CUSTOMER,
      technicianName: "Coupon Admin",
      technicianEmail: EMAIL_ADMIN,
      serviceTitle: `Coupon Test Service ${runId}`,
      serviceCategory: "AC Repair",
      serviceLocation: "Khulna",
      serviceImage: "https://example.com/coupon.jpg",
      hourlyRate: 50,
      securityDeposit: 25,
      problemDescription: "Completed booking for coupon redemption correctness test.",
      status: "completed",
      paymentStatus: "unpaid",
      finalAmount: 100,
      createdAt: now,
      updatedAt: now,
    });

    const redeemCode = `REDEEM${runId.slice(-3).toUpperCase().replace(/[^A-Z0-9]/g, "N")}`;
    const redeemCoupon = await api(APP_BASE, couponsPath, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        code: redeemCode,
        kind: "fixed",
        value: 20,
        currency: "usd",
        minBookingAmount: 50,
        startsAt: isoDaysFromNow(-1),
        expiresAt: isoDaysFromNow(30),
        perCustomerLimit: 1,
        globalLimit: 5,
      }),
    });
    check(redeemCoupon.status === 201, `redemption coupon created -> ${redeemCoupon.status}`);

    const preview = await api(APP_BASE, "/api/coupons/validate", {
      method: "POST",
      headers: jsonHeaders(customerToken),
      body: JSON.stringify({ code: redeemCode, bookingId: bookingId.toHexString() }),
    });
    check(
      preview.status === 200 && preview.body?.data?.discountAmount === 20 && preview.body?.data?.totalAmount === 80,
      `coupon preview discount math correct (100 -> 80) -> ${preview.status} ${JSON.stringify(preview.body?.data)}`
    );

    const checkout = await api(APP_BASE, "/api/payments/checkout-session", {
      method: "POST",
      headers: jsonHeaders(customerToken),
      body: JSON.stringify({ bookingId: bookingId.toHexString(), couponCode: redeemCode }),
    });
    check(
      checkout.status === 201 && checkout.body?.data?.amount === 80,
      `checkout creates discounted session amount 80 -> ${checkout.status} amount=${checkout.body?.data?.amount} body=${JSON.stringify(checkout.body)}`
    );
    // Coupon claim happens during checkout creation for global-limited coupons.
    const usageAfterCheckout = await readUsage(redeemCode);
    check(
      usageAfterCheckout === 1,
      `global usageCount incremented on successful checkout claim -> ${usageAfterCheckout}`
    );
    const paymentDoc = await payments.findOne({ bookingId });
    check(
      paymentDoc && paymentDoc.appliedCoupon?.code === redeemCode && paymentDoc.amount === 8000,
      `payment record stores applied coupon and discounted amount (cents) -> amount=${paymentDoc?.amount} code=${paymentDoc?.appliedCoupon?.code}`
    );

    // Per-customer limit remains enforced for the same customer after a
    // successful (claimed) redemption. Use a second completed unpaid booking.
    const bookingId2 = new ObjectId();
    await bookings.insertOne({
      _id: bookingId2,
      serviceId,
      customerId: customerUser._id,
      technicianId: adminUser._id,
      customerName: "Coupon Customer",
      customerEmail: EMAIL_CUSTOMER,
      technicianName: "Coupon Admin",
      technicianEmail: EMAIL_ADMIN,
      serviceTitle: `Coupon Test Service ${runId}`,
      serviceCategory: "AC Repair",
      serviceLocation: "Khulna",
      serviceImage: "https://example.com/coupon.jpg",
      hourlyRate: 50,
      securityDeposit: 25,
      problemDescription: "Second completed booking for per-customer coupon limit check.",
      status: "completed",
      paymentStatus: "unpaid",
      finalAmount: 100,
      createdAt: now,
      updatedAt: now,
    });
    // Mark first payment as succeeded with applied coupon so per-customer
    // redemption counting (based on settled successful payments) sees it.
    await payments.updateOne(
      { _id: paymentDoc._id },
      { $set: { status: "succeeded", paidAt: new Date(), updatedAt: new Date() } }
    );
    await bookings.updateOne({ _id: bookingId }, { $set: { paymentStatus: "paid" } });
    const reuse = await api(APP_BASE, "/api/coupons/validate", {
      method: "POST",
      headers: jsonHeaders(customerToken),
      body: JSON.stringify({ code: redeemCode, bookingId: bookingId2.toHexString() }),
    });
    check(
      reuse.status === 400,
      `per-customer coupon limit still enforced after redemption -> ${reuse.status} ${JSON.stringify(reuse.body?.message ?? reuse.body)}`
    );
  } finally {
    console.log("\n[cleanup]");
    try {
      // Drop only the temporary test database (never shared/prod data).
      await db.dropDatabase();
      tempDbDropped = true;
      console.log(`  dropped temp DB ${tempDbName}`);
    } catch (e) {
      console.error(`  failed to drop temp DB ${tempDbName}:`, e);
    }
    await client.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    await closeDB().catch(() => undefined);
    mockStripe.close();
    console.log(`  cleanup ${tempDbDropped ? "complete (temp DB dropped)" : "incomplete (temp DB NOT dropped)"}`);
  }

  console.log(
    `\n${failures === 0 ? "COUPON HARDENING CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`
  );
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("coupon hardening test crashed:", error);
  process.exit(1);
});
