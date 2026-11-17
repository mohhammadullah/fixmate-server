/**
 * FixMate booking-details endpoint test (development only).
 *
 * Verifies GET /api/bookings/:id (customer-owned, safe DTO) end-to-end
 * against a locally running server (default http://localhost:5000) with a
 * real MongoDB database. Seeds two bookings directly in MongoDB — one owned
 * by the signed-in account, one owned by a fabricated other customer — and
 * removes them when the script finishes. For the 403 case the account's
 * role is switched to "technician" (restored afterwards), same approach as
 * role-matrix-test.mjs.
 *
 * Auth: when TEST_USER_PASSWORD is set, the shared dev test account is used
 * (TEST_USER_EMAIL, default fixmate.test@example.com — same as the smoke
 * test). Otherwise the script creates its own throwaway account through the
 * public signup path (role is always "customer" at signup), exercises it,
 * and deletes it afterwards.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: TEST_USER_EMAIL, TEST_USER_PASSWORD, BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/booking-details-test.mjs
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const MANAGED_ACCOUNT = !process.env.TEST_USER_PASSWORD;
const TEST_EMAIL = MANAGED_ACCOUNT
  ? `fixmate.booking.test.${Date.now()}@example.com`
  : (process.env.TEST_USER_EMAIL ?? "fixmate.test@example.com");
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? crypto.randomUUID() + "Aa1!";
const TEST_NAME = "FixMate Booking Details Test";

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

const jsonHeaders = {
  "content-type": "application/json",
  origin: process.env.TEST_ORIGIN ?? "http://localhost:3000",
};

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

const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
});

const getJwt = async (sessionCookie) => {
  const tokenRes = await api("/api/auth/token", {
    headers: { cookie: sessionCookie },
  });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`could not obtain JWT (status ${tokenRes.status})`);
  }
  return tokenRes.body.token;
};

const main = async () => {
  console.log(`Booking-details test against ${BASE_URL}`);
  console.log(`Test account: ${TEST_EMAIL}\n`);

  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const bookings = db.collection("bookings");

  if (MANAGED_ACCOUNT) {
    console.log(`creating throwaway test account ${TEST_EMAIL}`);
    const signup = await api("/api/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME }),
    });
    if (signup.status !== 200 && signup.status !== 201) {
      throw new Error(`signup failed with status ${signup.status}: ${JSON.stringify(signup.body)}`);
    }
  }

  const testUser = await users.findOne({ email: TEST_EMAIL });
  if (!testUser) {
    throw new Error(`test user ${TEST_EMAIL} not found — run scripts/smoke-test.mjs first`);
  }
  const customerId = testUser._id;
  const originalRole = testUser.role ?? "customer";

  // --- Sign in once; session is role-independent ---
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (signin.status !== 200) {
    throw new Error(`signin failed with status ${signin.status}`);
  }
  const setCookie = signin.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.includes("session_token"))?.split(";")[0];
  if (!sessionCookie) throw new Error("no session cookie from signin");

  // --- Seed bookings directly (marked so cleanup can find them) ---
  const now = new Date();
  const ownBookingId = new ObjectId();
  const otherBookingId = new ObjectId();
  const otherCustomerId = new ObjectId();

  const baseBooking = {
    serviceId: new ObjectId(),
    technicianId: new ObjectId(),
    customerName: TEST_NAME,
    customerEmail: TEST_EMAIL,
    technicianName: "Seeded Technician",
    technicianEmail: "seeded.technician@example.com",
    serviceTitle: "Seeded AC Repair",
    serviceCategory: "AC Repair",
    serviceLocation: "Seeded Location",
    serviceImage: "https://example.com/seeded.jpg",
    hourlyRate: 45,
    securityDeposit: 50,
    problemDescription: "Seeded problem description for the booking-details test.",
    status: "requested",
    paymentStatus: "unpaid",
    createdAt: now,
    updatedAt: now,
  };

  await bookings.insertMany([
    { _id: ownBookingId, ...baseBooking, customerId },
    { _id: otherBookingId, ...baseBooking, customerId: otherCustomerId },
  ]);
  console.log(`seeded bookings: own=${ownBookingId.toHexString()} other=${otherBookingId.toHexString()}\n`);

  try {
    const token = await getJwt(sessionCookie);
    const auth = { headers: { authorization: `Bearer ${token}` } };

    // --- Unauthenticated request -> 401 ---
    console.log("[unauthenticated]");
    const anon = await api(`/api/bookings/${ownBookingId.toHexString()}`);
    check(anon.status === 401, `GET /api/bookings/:id without token -> ${anon.status} (expected 401)`);

    // --- Non-customer role -> 403 (role switched, fresh JWT, restored after) ---
    console.log("\n[non-customer role]");
    await users.updateOne({ _id: customerId }, { $set: { role: "technician" } });
    try {
      const techToken = await getJwt(sessionCookie);
      const techRes = await api(`/api/bookings/${ownBookingId.toHexString()}`, {
        headers: { authorization: `Bearer ${techToken}` },
      });
      check(techRes.status === 403, `GET /api/bookings/:id as technician -> ${techRes.status} (expected 403)`);
    } finally {
      await users.updateOne({ _id: customerId }, { $set: { role: originalRole } });
    }

    // --- Invalid ObjectId -> 400 ---
    console.log("\n[invalid id]");
    const badId = await api("/api/bookings/not-an-object-id", auth);
    check(badId.status === 400, `GET /api/bookings/not-an-object-id -> ${badId.status} (expected 400)`);
    const shortId = await api("/api/bookings/0123456789ab", auth);
    check(shortId.status === 400, `GET /api/bookings/12-byte-hex -> ${shortId.status} (expected 400)`);

    // --- Non-existent booking -> 404 ---
    console.log("\n[not found]");
    const missing = await api(`/api/bookings/${new ObjectId().toHexString()}`, auth);
    check(missing.status === 404, `GET /api/bookings/<random-id> -> ${missing.status} (expected 404)`);

    // --- Another customer's booking -> 404 (indistinguishable from missing) ---
    console.log("\n[owned by another customer]");
    const foreign = await api(`/api/bookings/${otherBookingId.toHexString()}`, auth);
    check(foreign.status === 404, `GET /api/bookings/<other-customer-id> -> ${foreign.status} (expected 404)`);

    // --- Own booking -> 200 with safe DTO ---
    console.log("\n[own booking]");
    const own = await api(`/api/bookings/${ownBookingId.toHexString()}`, auth);
    check(own.status === 200 && own.body?.success === true, `GET /api/bookings/:id -> ${own.status} (expected 200)`);

    const dto = own.body?.data ?? {};
    check(dto.id === ownBookingId.toHexString(), "dto.id matches booking id");
    check(dto.service?.title === baseBooking.serviceTitle, "dto.service.title present");
    check(dto.service?.category === baseBooking.serviceCategory, "dto.service.category present");
    check(dto.service?.location === baseBooking.serviceLocation, "dto.service.location present");
    check(dto.service?.image === baseBooking.serviceImage, "dto.service.image present");
    check(dto.service?.hourlyRate === baseBooking.hourlyRate, "dto.service.hourlyRate present");
    check(typeof dto.technician?.name === "string" && dto.technician.name.length > 0, "dto.technician.name present");
    check(dto.problemDescription === baseBooking.problemDescription, "dto.problemDescription present");
    check(dto.status === baseBooking.status, "dto.status present");
    check(dto.paymentStatus === baseBooking.paymentStatus, "dto.paymentStatus present");
    check(Boolean(dto.createdAt) && Boolean(dto.updatedAt), "dto.createdAt/updatedAt present");
    check(!("finalAmount" in dto), "dto.finalAmount omitted while unset");

    const leakedKeys = [
      "_id",
      "customerId",
      "technicianId",
      "serviceId",
      "customerName",
      "customerEmail",
      "technicianEmail",
      "securityDeposit",
    ].filter((key) => key in dto || key in (dto.service ?? {}) || key in (dto.technician ?? {}));
    check(leakedKeys.length === 0, `dto exposes no internal/sensitive keys (found: ${leakedKeys.join(", ") || "none"})`);

    // finalAmount appears once set (simulating a completed booking)
    await bookings.updateOne({ _id: ownBookingId }, { $set: { finalAmount: 120, status: "completed" } });
    const settled = await api(`/api/bookings/${ownBookingId.toHexString()}`, auth);
    check(
      settled.status === 200 && settled.body?.data?.finalAmount === 120,
      "dto.finalAmount present once set"
    );
  } finally {
    await bookings.deleteMany({ _id: { $in: [ownBookingId, otherBookingId] } });
    await users.updateOne({ _id: customerId }, { $set: { role: originalRole } });
    console.log("\ncleanup: seeded bookings removed, role restored");
    if (MANAGED_ACCOUNT) {
      await sessions.deleteMany({ userId: customerId });
      await accounts.deleteMany({ userId: customerId });
      await users.deleteOne({ _id: customerId });
      console.log("cleanup: throwaway test account deleted");
    }
    await client.close();
  }

  console.log(`\n${failures === 0 ? "BOOKING-DETAILS CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("booking-details test crashed:", e);
  try {
    await client.close();
  } catch {}
  process.exit(1);
});
