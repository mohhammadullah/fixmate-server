/**
 * FixMate customer review flow — integration test (development only).
 *
 * Covers the whole review feature end-to-end against a real MongoDB:
 *   - authentication required for POST /api/bookings/:id/review (401)
 *   - technicians and admins cannot submit customer reviews (403)
 *   - only the booking owner can review it (another customer's -> 404)
 *   - only completed bookings are eligible (accepted -> 409)
 *   - one review per booking (duplicate -> 409)
 *   - invalid rating/comment payloads are rejected (400)
 *   - the public GET /api/reviews returns real reviews with a privacy-safe
 *     DTO (no emails, phones, ids or secrets)
 *   - GET /api/services exposes real rating/count from stored reviews
 *   - GET /api/home/summary returns real stats with privacy-safe DTOs
 *   - GET /api/bookings/:id exposes the review to the owner
 *
 * Seeds one approved service and three bookings directly in MongoDB:
 * one completed booking owned by the signed-in customer (eligible), one
 * completed booking owned by a fabricated other customer, and one
 * not-yet-completed booking owned by the test customer. Everything is
 * removed afterwards.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: TEST_USER_EMAIL, TEST_USER_PASSWORD, BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/with-isolated-app.mjs scripts/review-test.mjs
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const MANAGED_ACCOUNT = !process.env.TEST_USER_PASSWORD;
const TEST_EMAIL = MANAGED_ACCOUNT
  ? `fixmate.review.test.${Date.now()}@example.com`
  : (process.env.TEST_USER_EMAIL ?? "fixmate.test@example.com");
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? crypto.randomUUID() + "Aa1!";
const TEST_NAME = "FixMate Review Test";
const SEEDED_SERVICE_TITLE = `Seeded Review Test Service ${Date.now()}`;
const SEEDED_SERVICE_LOCATION = "Seeded Reviewville";

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

const VALID_REVIEW = {
  rating: 5,
  comment: "Outstanding repair — everything works perfectly again.",
};

const main = async () => {
  console.log(`Review-flow test against ${BASE_URL}`);
  console.log(`Test account: ${TEST_EMAIL}\n`);

  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const bookings = db.collection("bookings");
  const services = db.collection("services");

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
    throw new Error(`test user ${TEST_EMAIL} not found`);
  }
  const customerId = testUser._id;
  const originalRole = testUser.role ?? "customer";

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

  // --- Seed one approved service + three bookings directly in MongoDB ---
  const now = new Date();
  const serviceId = new ObjectId();
  const technicianId = new ObjectId();
  const eligibleBookingId = new ObjectId();
  const otherCustomerBookingId = new ObjectId();
  const inProgressBookingId = new ObjectId();
  const otherCustomerId = new ObjectId();

  await services.insertOne({
    _id: serviceId,
    title: SEEDED_SERVICE_TITLE,
    category: "AC Repair",
    description: "Seeded service for the review-flow integration test.",
    overview: "Seeded overview for the review-flow integration test.",
    hourlyRate: 55,
    securityDeposit: 50,
    maxCapacity: 5,
    location: SEEDED_SERVICE_LOCATION,
    image: "https://example.com/review-test.jpg",
    amenities: ["Seeded amenity"],
    technicianId,
    technicianName: "Seeded Review Technician",
    technicianEmail: "seeded.review.technician@example.com",
    approvalStatus: "approved",
    availabilityStatus: "available",
    createdAt: now,
    updatedAt: now,
  });

  const baseBooking = {
    serviceId,
    technicianId,
    technicianName: "Seeded Review Technician",
    technicianEmail: "seeded.review.technician@example.com",
    serviceTitle: SEEDED_SERVICE_TITLE,
    serviceCategory: "AC Repair",
    serviceLocation: SEEDED_SERVICE_LOCATION,
    serviceImage: "https://example.com/review-test.jpg",
    hourlyRate: 55,
    securityDeposit: 50,
    problemDescription: "Seeded problem description for the review-flow test.",
    paymentStatus: "unpaid",
    createdAt: now,
    updatedAt: now,
  };

  await bookings.insertMany([
    {
      _id: eligibleBookingId,
      ...baseBooking,
      customerId,
      customerName: TEST_NAME,
      customerEmail: TEST_EMAIL,
      status: "completed",
      finalAmount: 220,
    },
    {
      _id: otherCustomerBookingId,
      ...baseBooking,
      customerId: otherCustomerId,
      customerName: "Seeded Other Customer",
      customerEmail: "seeded.other@example.com",
      status: "completed",
      finalAmount: 300,
    },
    {
      _id: inProgressBookingId,
      ...baseBooking,
      customerId,
      customerName: TEST_NAME,
      customerEmail: TEST_EMAIL,
      status: "in-progress",
    },
  ]);
  console.log(`seeded service=${serviceId.toHexString()} eligible=${eligibleBookingId.toHexString()} inProgress=${inProgressBookingId.toHexString()}\n`);

  try {
    const token = await getJwt(sessionCookie);
    const auth = { headers: { authorization: `Bearer ${token}` } };

    // --- Unauthenticated -> 401 ---
    console.log("[unauthenticated]");
    const anon = await api(`/api/bookings/${eligibleBookingId.toHexString()}/review`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(VALID_REVIEW),
    });
    check(anon.status === 401, `POST review without token -> ${anon.status} (expected 401)`);

    // --- Technician cannot review (403) ---
    console.log("\n[technician role]");
    await users.updateOne({ _id: customerId }, { $set: { role: "technician" } });
    try {
      const techToken = await getJwt(sessionCookie);
      const techRes = await api(`/api/bookings/${eligibleBookingId.toHexString()}/review`, {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${techToken}` },
        body: JSON.stringify(VALID_REVIEW),
      });
      check(techRes.status === 403, `POST review as technician -> ${techRes.status} (expected 403)`);
    } finally {
      await users.updateOne({ _id: customerId }, { $set: { role: originalRole } });
    }

    // --- Admin cannot review (403) ---
    console.log("\n[admin role]");
    await users.updateOne({ _id: customerId }, { $set: { role: "admin" } });
    try {
      const adminToken = await getJwt(sessionCookie);
      const adminRes = await api(`/api/bookings/${eligibleBookingId.toHexString()}/review`, {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(VALID_REVIEW),
      });
      check(adminRes.status === 403, `POST review as admin -> ${adminRes.status} (expected 403)`);
    } finally {
      await users.updateOne({ _id: customerId }, { $set: { role: originalRole } });
    }

    // --- Invalid payloads -> 400 ---
    console.log("\n[invalid payloads]");
    const invalidPayloads = [
      { name: "rating 0", body: { rating: 0, comment: VALID_REVIEW.comment } },
      { name: "rating 6", body: { rating: 6, comment: VALID_REVIEW.comment } },
      { name: "rating 3.5", body: { rating: 3.5, comment: VALID_REVIEW.comment } },
      { name: "rating as string", body: { rating: "5", comment: VALID_REVIEW.comment } },
      { name: "comment too short", body: { rating: 5, comment: "Too short" } },
      { name: "comment too long", body: { rating: 5, comment: "x".repeat(1001) } },
      { name: "missing comment", body: { rating: 5 } },
      { name: "unknown keys rejected", body: { ...VALID_REVIEW, customerId: otherCustomerId.toHexString(), serviceId: serviceId.toHexString() } },
    ];
    for (const { name, body } of invalidPayloads) {
      const res = await api(`/api/bookings/${eligibleBookingId.toHexString()}/review`, {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      check(res.status === 400, `${name} -> ${res.status} (expected 400)`);
    }

    // --- Non-existent booking -> 404 ---
    console.log("\n[not found]");
    const missing = await api(`/api/bookings/${new ObjectId().toHexString()}/review`, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: JSON.stringify(VALID_REVIEW),
    });
    check(missing.status === 404, `POST review on random booking -> ${missing.status} (expected 404)`);

    // --- Another customer's booking -> 404 ---
    console.log("\n[owned by another customer]");
    const foreign = await api(`/api/bookings/${otherCustomerBookingId.toHexString()}/review`, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: JSON.stringify(VALID_REVIEW),
    });
    check(foreign.status === 404, `POST review on another customer's booking -> ${foreign.status} (expected 404)`);

    // --- Not completed yet -> 409 ---
    console.log("\n[not completed]");
    const notDone = await api(`/api/bookings/${inProgressBookingId.toHexString()}/review`, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: JSON.stringify(VALID_REVIEW),
    });
    check(notDone.status === 409, `POST review on in-progress booking -> ${notDone.status} (expected 409)`);

    // --- Valid submission -> 201 ---
    console.log("\n[valid submission]");
    const submitted = await api(`/api/bookings/${eligibleBookingId.toHexString()}/review`, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: JSON.stringify(VALID_REVIEW),
    });
    check(submitted.status === 201 && submitted.body?.success === true, `POST review -> ${submitted.status} (expected 201)`);
    check(submitted.body?.data?.rating === 5, "response echoes rating 5");
    check(typeof submitted.body?.data?.createdAt === "string", "response includes createdAt");

    // --- Duplicate -> 409 ---
    console.log("\n[duplicate]");
    const duplicate = await api(`/api/bookings/${eligibleBookingId.toHexString()}/review`, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
      body: JSON.stringify({ rating: 4, comment: "Trying to review the same booking twice." }),
    });
    check(duplicate.status === 409, `POST duplicate review -> ${duplicate.status} (expected 409)`);

    // --- Booking details DTO includes the review (owner only) ---
    console.log("\n[booking details review]");
    const details = await api(`/api/bookings/${eligibleBookingId.toHexString()}`, auth);
    const dto = details.body?.data ?? {};
    check(
      details.status === 200 && dto.review?.rating === 5 && typeof dto.review?.comment === "string",
      "GET /api/bookings/:id exposes the submitted review to the owner"
    );

    // --- Public latest reviews: real data, safe DTO ---
    console.log("\n[public latest reviews]");
    const publicReviews = await api("/api/reviews?limit=6");
    check(publicReviews.status === 200 && publicReviews.body?.success === true, `GET /api/reviews -> ${publicReviews.status} (expected 200)`);
    const reviews = Array.isArray(publicReviews.body?.data) ? publicReviews.body.data : [];
    const seeded = reviews.find(
      (r) => r?.service?.title === SEEDED_SERVICE_TITLE && r?.rating === 5
    );
    check(Boolean(seeded), "public feed contains the seeded review");
    if (seeded) {
      check(seeded.comment === VALID_REVIEW.comment, "public feed returns the real comment");
      check(seeded.customer?.name === TEST_NAME, "public feed returns the customer display name");
      check(seeded.service?.category === "AC Repair", "public feed returns the service category");
      check(typeof seeded.technician?.name === "string", "public feed returns the technician display name");
      check(typeof seeded.createdAt === "string", "public feed returns the review date");
      const leaked = JSON.stringify(seeded);
      check(
        !/customerEmail|technicianEmail|customerId|serviceId|technicianId|_id|email|phone/i.test(leaked),
        "public review DTO contains no private fields"
      );
    }
    const tooMany = await api(`/api/reviews?limit=25`);
    check(tooMany.status === 400, `GET /api/reviews?limit=25 -> ${tooMany.status} (expected 400, cap 24)`);

    const pageTwo = await api(`/api/reviews?page=2&limit=1`);
    check(
      pageTwo.status === 200 && typeof pageTwo.body?.pagination?.currentPage === "number",
      `GET /api/reviews?page=2&limit=1 -> ${pageTwo.status} with pagination envelope`
    );

    // --- Service listing carries real rating data ---
    console.log("\n[service rating aggregation]");
    const serviceList = await api(
      `/api/services?search=${encodeURIComponent(SEEDED_SERVICE_TITLE)}&limit=6`
    );
    const listed = Array.isArray(serviceList.body?.data) ? serviceList.body.data : [];
    const seededService = listed.find((s) => s?.title === SEEDED_SERVICE_TITLE);
    check(Boolean(seededService), "seeded approved service is discoverable");
    if (seededService) {
      check(
        seededService.rating?.reviewCount === 1 && seededService.rating?.averageRating === 5,
        `service rating aggregated from reviews (got count=${seededService.rating?.reviewCount}, avg=${seededService.rating?.averageRating})`
      );
      check(
        !("technicianEmail" in seededService) && !("technicianId" in seededService) && !("rejectionReason" in seededService),
        "service listing strips internal-only fields"
      );
    }

    // --- Service details carries the same rating ---
    const serviceDetails = await api(`/api/services/${serviceId.toHexString()}`);
    check(
      serviceDetails.status === 200 && serviceDetails.body?.data?.rating?.reviewCount === 1,
      "service details exposes the aggregated rating"
    );

    // --- Homepage summary: real stats, safe DTOs ---
    console.log("\n[home summary]");
    const summary = await api("/api/home/summary");
    check(summary.status === 200 && summary.body?.success === true, `GET /api/home/summary -> ${summary.status} (expected 200)`);
    const stats = summary.body?.data?.stats ?? {};
    check(Number.isInteger(stats.approvedServices) && stats.approvedServices >= 1, `approvedServices is a real count (got ${stats.approvedServices})`);
    check(Number.isInteger(stats.activeTechnicians) && stats.activeTechnicians >= 1, `activeTechnicians is a real distinct count (got ${stats.activeTechnicians})`);
    check(Number.isInteger(stats.completedRepairs) && stats.completedRepairs >= 2, `completedRepairs is a real count (got ${stats.completedRepairs})`);
    check(Number.isInteger(stats.totalReviews) && stats.totalReviews >= 1, `totalReviews is a real count (got ${stats.totalReviews})`);
    check(typeof stats.averageRating === "number" && stats.averageRating >= 1 && stats.averageRating <= 5, `averageRating computed from reviews (got ${stats.averageRating})`);
    const recent = Array.isArray(summary.body?.data?.recentBookings) ? summary.body.data.recentBookings : [];
    check(recent.length > 0 && recent.length <= 3, `recentBookings is bounded (got ${recent.length})`);
    const seededRecent = recent.find((r) => r?.serviceTitle === SEEDED_SERVICE_TITLE);
    check(Boolean(seededRecent), "recent activity includes the seeded booking");
    for (const entry of recent) {
      const keys = Object.keys(entry).sort();
      check(
        keys.join(",") === ["category", "createdAt", "serviceTitle", "status"].join(","),
        `recent booking exposes only safe keys (got: ${keys.join(",")})`
      );
    }
    const recentLeak = JSON.stringify(recent);
    check(!/email|phone|customerId|technicianId|serviceId|customerName/i.test(recentLeak), "recent bookings contain no private identity fields");
  } finally {
    await bookings.deleteMany({ _id: { $in: [eligibleBookingId, otherCustomerBookingId, inProgressBookingId] } });
    await services.deleteMany({ _id: serviceId });
    await users.updateOne({ _id: customerId }, { $set: { role: originalRole } });
    console.log("\ncleanup: seeded service/bookings removed, role restored");
    if (MANAGED_ACCOUNT) {
      await sessions.deleteMany({ userId: customerId });
      await accounts.deleteMany({ userId: customerId });
      await users.deleteOne({ _id: customerId });
      console.log("cleanup: throwaway test account deleted");
    }
    await client.close();
  }

  console.log(`\n${failures === 0 ? "REVIEW CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("review test crashed:", e);
  try {
    await client.close();
  } catch {}
  process.exit(1);
});
