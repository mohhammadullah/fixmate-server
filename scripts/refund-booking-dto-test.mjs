/**
 * FixMate — customer refund + booking DTO integration test (isolated app).
 *
 * Run with:
 *   npm run build && node scripts/with-isolated-app.mjs scripts/refund-booking-dto-test.mjs
 *
 * Seeds only throwaway users/service/bookings/payments and removes them at
 * the end. Never touches the shared smoke-test account.
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

const signUpAndSignIn = async (email, password, name) => {
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
  const cookie = (signin.headers?.getSetCookie?.() ?? [])
    .find((entry) => entry.includes("session_token"))
    ?.split(";")[0];
  if (!cookie) throw new Error("no session cookie from signin");
  const tokenRes = await api("/api/auth/token", { headers: { cookie } });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error("could not obtain JWT");
  }
  return tokenRes.body.token;
};

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

const main = async () => {
  console.log(`Refund + booking DTO test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const bookings = db.collection("bookings");
  const services = db.collection("services");
  const payments = db.collection("payments");

  const runId = Date.now();
  const emails = [
    `fixmate.refund.customer.${runId}@example.com`,
    `fixmate.refund.tech.${runId}@example.com`,
    `fixmate.refund.outsider.${runId}@example.com`,
  ];
  const password = `Refund-${runId}-Aa1!`;
  const seededBookings = [];
  const seededPayments = [];
  let serviceId;

  try {
    console.log("[setup]");
    const tokenA = await signUpAndSignIn(emails[0], password, "Refund Customer");
    const tokenT = await signUpAndSignIn(emails[1], password, "Refund Technician");
    const tokenC = await signUpAndSignIn(emails[2], password, "Refund Outsider");
    const userA = await users.findOne({ email: emails[0] });
    const userT = await users.findOne({ email: emails[1] });
    const userC = await users.findOne({ email: emails[2] });
    if (!userA || !userT || !userC) throw new Error("failed to seed users");
    await users.updateOne({ _id: userT._id }, { $set: { role: "technician" } });

    const now = new Date();
    serviceId = new ObjectId();
    await services.insertOne({
      _id: serviceId,
      title: `Refund Test Service ${runId}`,
      category: "AC Repair",
      description: "Seeded service for the refund/DTO test.",
      overview: "Seeded overview.",
      hourlyRate: 50,
      securityDeposit: 25,
      maxCapacity: 3,
      location: "Khulna",
      image: "https://example.com/refund.jpg",
      amenities: [],
      technicianId: userT._id,
      technicianName: "Refund Technician",
      technicianEmail: emails[1],
      approvalStatus: "approved",
      availabilityStatus: "available",
      createdAt: now,
      updatedAt: now,
    });

    const createBooking = async (token) => {
      const res = await api("/api/bookings", {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({
          serviceId: serviceId.toHexString(),
          problemDescription: "The unit is not cooling and needs inspection.",
        }),
      });
      if (res.status !== 201) throw new Error(`booking create ${res.status}: ${JSON.stringify(res.body)}`);
      const id = new ObjectId(res.body.data._id);
      seededBookings.push(id);
      return { id, body: res.body };
    };

    const seedSucceededPayment = async (bookingId) => {
      const _id = new ObjectId();
      await payments.insertOne({
        _id,
        bookingId,
        customerId: userA._id,
        technicianId: userT._id,
        stripeSessionId: `cs_refund_test_${runId}_${_id.toHexString()}`,
        stripePaymentIntentId: `pi_refund_test_${_id.toHexString()}`,
        amount: 12000,
        currency: "usd",
        status: "succeeded",
        createdAt: now,
        updatedAt: now,
        paidAt: now,
      });
      seededPayments.push(_id);
      return _id;
    };

    const requestRefund = (paymentId, token, reason) =>
      api(`/api/payments/${paymentId.toHexString()}/refunds`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ reason }),
      });

    // ============ Part B: booking response privacy ============
    console.log("\n[booking DTO privacy]");
    const created = await createBooking(tokenA);
    const privateKeys = [
      "customerEmail",
      "technicianEmail",
      "securityDeposit",
      "customerId",
      "serviceId",
      "technicianId",
    ];
    check(
      typeof created.body.data._id === "string" &&
        privateKeys.every((key) => !(key in created.body.data)),
      `create response is sanitized -> leaked: ${privateKeys.filter((k) => k in created.body.data).join(",") || "none"}`
    );

    const myBookings = await api("/api/bookings/my", {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    check(
      myBookings.status === 200 &&
        Array.isArray(myBookings.body?.data) &&
        myBookings.body.data.every((b) => privateKeys.every((key) => !(key in b))),
      `customer list is sanitized -> ${myBookings.status}`
    );

    const accept = await api(`/api/bookings/${created.id.toHexString()}/accept`, {
      method: "PATCH",
      headers: jsonHeaders(tokenT),
      body: "{}",
    });
    check(
      accept.status === 200 && privateKeys.every((key) => !(key in (accept.body.data ?? {}))),
      `accept response is sanitized -> ${accept.status}`
    );
    const technicianList = await api("/api/bookings/technician", {
      headers: { authorization: `Bearer ${tokenT}` },
    });
    check(
      technicianList.status === 200 &&
        Array.isArray(technicianList.body?.data) &&
        technicianList.body.data.every((b) => !("customerEmail" in b) && !("securityDeposit" in b)),
      `technician list hides customer email/deposit -> ${technicianList.status}`
    );

    const details = await api(`/api/bookings/${created.id.toHexString()}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    check(
      details.status === 200 && details.body?.data?.id === created.id.toHexString(),
      `customer booking details still work -> ${details.status}`
    );
    const foreignDetails = await api(`/api/bookings/${created.id.toHexString()}`, {
      headers: { authorization: `Bearer ${tokenC}` },
    });
    check(foreignDetails.status === 404, `outsider cannot view booking -> ${foreignDetails.status}`);

    const startWork = await api(`/api/bookings/${created.id.toHexString()}/status`, {
      method: "PATCH",
      headers: jsonHeaders(tokenT),
      body: JSON.stringify({ status: "in-progress" }),
    });
    check(startWork.status === 200, `accepted -> in-progress works -> ${startWork.status}`);
    const complete = await api(`/api/bookings/${created.id.toHexString()}/status`, {
      method: "PATCH",
      headers: jsonHeaders(tokenT),
      body: JSON.stringify({ status: "completed", finalAmount: 120 }),
    });
    check(
      complete.status === 200 &&
        complete.body?.data?.finalAmount === 120 &&
        privateKeys.every((key) => !(key in (complete.body.data ?? {}))),
      `status transition preserves finalAmount without private fields -> ${complete.status}`
    );

    // ============ Part A: customer refund requests ============
    console.log("\n[refund requests]");
    const paymentId = await seedSucceededPayment(created.id);

    const shortReason = await requestRefund(paymentId, tokenA, "too short");
    check(shortReason.status === 400, `reason under 10 chars rejected -> ${shortReason.status}`);
    const longReason = await requestRefund(paymentId, tokenA, "x".repeat(501));
    check(longReason.status === 400, `reason over 500 chars rejected -> ${longReason.status}`);
    const foreign = await requestRefund(paymentId, tokenC, "I am not the owner of this payment.");
    check(foreign.status === 404, `another customer cannot request refund -> ${foreign.status}`);

    const valid = await requestRefund(paymentId, tokenA, "The repair did not fix the issue.");
    check(
      valid.status === 201 && valid.body?.data?.status === "pending",
      `owner submits valid request -> ${valid.status} ${valid.body?.data?.status}`
    );
    const pendingPayment = await payments.findOne({ _id: paymentId });
    check(
      (pendingPayment.refunds ?? []).length === 1 &&
        pendingPayment.refunds[0].status === "pending",
      "pending refund stored on the payment"
    );

    const duplicate = await requestRefund(paymentId, tokenA, "A second request should be blocked.");
    check(duplicate.status === 409, `duplicate pending request rejected -> ${duplicate.status}`);

    const myPayments = await api("/api/payments/my", {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    check(
      myPayments.status === 200 &&
        myPayments.body?.data?.find((p) => p.id === paymentId.toHexString())?.refunds?.[0]?.status === "pending",
      "customer payment history exposes the pending refund state"
    );

    // Admin rejection still works (approval needs Stripe and is covered by
    // the features test's mock Stripe server).
    await users.updateOne({ _id: userC._id }, { $set: { role: "admin" } });
    const adminRefunds = await api("/api/admin/refunds?status=pending", {
      headers: { authorization: `Bearer ${tokenC}` },
    });
    check(
      adminRefunds.status === 200 &&
        (adminRefunds.body?.data ?? []).some((r) => r.id === valid.body.data.id),
      `admin queue shows the pending request -> ${adminRefunds.status}`
    );
    const reject = await api(
      `/api/admin/refunds/${paymentId.toHexString()}/${valid.body.data.id}/decide`,
      {
        method: "POST",
        headers: jsonHeaders(tokenC),
        body: JSON.stringify({ decision: "reject", note: "Not eligible under policy." }),
      }
    );
    check(reject.status === 200 && reject.body?.data?.status === "rejected", `admin rejection still works -> ${reject.status}`);
    await users.updateOne({ _id: userC._id }, { $set: { role: "customer" } });
  } finally {
    console.log("\n[cleanup]");
    await payments.deleteMany({ _id: { $in: seededPayments } });
    await bookings.deleteMany({ _id: { $in: seededBookings } });
    if (serviceId) await services.deleteOne({ _id: serviceId });
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

  console.log(`\n${failures === 0 ? "REFUND + DTO CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("refund/DTO test crashed:", error);
  process.exit(1);
});
