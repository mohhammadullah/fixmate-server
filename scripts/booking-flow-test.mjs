/**
 * FixMate booking workflow / ownership integration test (development only).
 *
 * Verifies the booking lifecycle authorization boundaries end-to-end against
 * an isolated in-process app (via scripts/with-isolated-app.mjs) or the
 * BASE_URL server. Seeds one approved service and exercises customer create,
 * technician ownership, cross-user rejection, status transitions,
 * cancellation ownership, and cancelled-booking visibility (default
 * exclusion from the customer/technician lists, explicit ?status=cancelled
 * filtering, ownership isolation, and pagination totals). Throwaway users,
 * bookings and services are seeded and removed on completion.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/with-isolated-app.mjs scripts/booking-flow-test.mjs
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
  const email = `fixmate.flow.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST", headers,
    body: JSON.stringify({ email, password, name: `Flow ${label}` }),
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
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") throw new Error(`token ${label} failed`);
  const user = await db.collection("user").findOne({ email });
  return { email, password, name: `Flow ${label}`, userId: user._id, token: tokenRes.body.token };
};

const main = async () => {
  console.log(`Booking-flow test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const services = db.collection("services");
  const bookings = db.collection("bookings");

  const techA = await makeUser(db, "techa", "technician");
  const techB = await makeUser(db, "techb", "technician");
  const custC = await makeUser(db, "custc", "customer");
  const custD = await makeUser(db, "custd", "customer");
  console.log("throwaway users created: techA, techB, custC, custD\n");

  const now = new Date();
  const serviceId = new ObjectId();
  await services.insertOne({
    _id: serviceId,
    title: "Flow Test Repair",
    category: "AC Repair",
    description: "Seeded for the booking-flow integration test.",
    overview: "Seeded overview for the flow test.",
    hourlyRate: 50,
    securityDeposit: 20,
    maxCapacity: 2,
    location: "Flow City",
    image: "https://example.com/flow.jpg",
    amenities: [],
    technicianId: techA.userId,
    technicianName: techA.name,
    technicianEmail: techA.email,
    approvalStatus: "approved",
    availabilityStatus: "available",
    createdAt: now,
    updatedAt: now,
  });

  const cleanup = async () => {
    await bookings.deleteMany({ customerId: { $in: [custC.userId, custD.userId] } });
    await services.deleteOne({ _id: serviceId });
    const ids = [techA.userId, techB.userId, custC.userId, custD.userId];
    await users.deleteMany({ _id: { $in: ids } });
    await sessions.deleteMany({ userId: { $in: ids } });
    await accounts.deleteMany({ userId: { $in: ids } });
  };

  try {
    // --- Customer creates a booking for the approved service ---
    console.log("[create booking]");
    const create = await api("/api/bookings", {
      method: "POST", headers: auth(custC.token),
      body: JSON.stringify({ serviceId: serviceId.toHexString(), problemDescription: "The unit blows warm air constantly." }),
    });
    check(create.status === 201 && create.body?.success === true, `create booking -> ${create.status} (expected 201)`);
    const bookingId = create.body?.data?._id;
    check(typeof bookingId === "string" && bookingId.length > 0 ? true : false, "booking id returned");

    const createByTechnician = await api("/api/bookings", {
      method: "POST", headers: auth(techA.token),
      body: JSON.stringify({ serviceId: serviceId.toHexString(), problemDescription: "Technician should not book." }),
    });
    check(createByTechnician.status === 403, `technician cannot create booking -> ${createByTechnician.status} (expected 403)`);
    const createForOthersService = await api("/api/bookings", {
      method: "POST", headers: auth(custD.token),
      body: JSON.stringify({ serviceId: serviceId.toHexString(), problemDescription: "Another customer books the same service." }),
    });
    check(createForOthersService.status === 201, `second customer can book the same service -> ${createForOthersService.status}`);

    // --- Listing ownership ---
    console.log("\n[list ownership]");
    const listB = await api("/api/bookings/technician", { headers: auth(techB.token) });
    check(
      listB.status === 200 && !(listB.body?.data ?? []).some((b) => b._id === bookingId),
      "technician B does not see technician A's bookings"
    );
    const listA = await api("/api/bookings/technician", { headers: auth(techA.token) });
    check(
      listA.status === 200 && (listA.body?.data ?? []).some((b) => b._id === bookingId),
      "technician A sees the new booking"
    );

    // --- Cross-user mutation attempts ---
    console.log("\n[cross-user mutations]");
    const techBAccept = await api(`/api/bookings/${bookingId}/accept`, {
      method: "PATCH", headers: auth(techB.token), body: "{}",
    });
    check(techBAccept.status === 404, `tech B cannot accept tech A's booking -> ${techBAccept.status} (expected 404)`);
    const customerAccept = await api(`/api/bookings/${bookingId}/accept`, {
      method: "PATCH", headers: auth(custC.token), body: "{}",
    });
    check(customerAccept.status === 403, `customer cannot accept -> ${customerAccept.status} (expected 403)`);
    const techBStatus = await api(`/api/bookings/${bookingId}/status`, {
      method: "PATCH", headers: auth(techB.token), body: JSON.stringify({ status: "in-progress" }),
    });
    check(techBStatus.status === 404, `tech B cannot transition status -> ${techBStatus.status} (expected 404)`);
    const customerCancelOwn = await api(`/api/bookings/${bookingId}/cancel`, {
      method: "PATCH", headers: auth(custC.token), body: "{}",
    });
    // Own booking, still requested -> 200 cancel succeeds; use it to assert its own ownership works
    check(customerCancelOwn.status === 200, `owner customer can cancel requested booking -> ${customerCancelOwn.status}`);

    // Re-book for the transition tests with a fresh record
    console.log("\n[transitions]");
    const rebook = await api("/api/bookings", {
      method: "POST", headers: auth(custC.token),
      body: JSON.stringify({ serviceId: serviceId.toHexString(), problemDescription: "Second booking for transition tests." }),
    });
    check(rebook.status === 201, `re-book for transitions -> ${rebook.status}`);
    const booking2Id = rebook.body?.data?._id;

    const techBReject = await api(`/api/bookings/${booking2Id}/reject`, {
      method: "PATCH", headers: auth(techB.token), body: "{}",
    });
    check(techBReject.status === 404, `tech B cannot reject -> ${techBReject.status} (expected 404)`);
    const techAReject = await api(`/api/bookings/${booking2Id}/reject`, {
      method: "PATCH", headers: auth(techA.token), body: "{}",
    });
    check(techAReject.status === 200, `tech A rejects -> ${techAReject.status} (expected 200)`);

    const rebook3 = await api("/api/bookings", {
      method: "POST", headers: auth(custC.token),
      body: JSON.stringify({ serviceId: serviceId.toHexString(), problemDescription: "Third booking for the full lifecycle." }),
    });
    const booking3Id = rebook3.body?.data?._id;
    const techAAccept = await api(`/api/bookings/${booking3Id}/accept`, {
      method: "PATCH", headers: auth(techA.token), body: "{}",
    });
    check(techAAccept.status === 200 && techAAccept.body?.data?.status === "accepted", `tech A accepts -> ${techAAccept.status}`);
    const techAAcceptAgain = await api(`/api/bookings/${booking3Id}/accept`, {
      method: "PATCH", headers: auth(techA.token), body: "{}",
    });
    check(techAAcceptAgain.status === 409, `double accept -> ${techAAcceptAgain.status} (expected 409)`);
    const toInProgress = await api(`/api/bookings/${booking3Id}/status`, {
      method: "PATCH", headers: auth(techA.token), body: JSON.stringify({ status: "in-progress" }),
    });
    check(toInProgress.status === 200 && toInProgress.body?.data?.status === "in-progress", `accepted -> in-progress -> ${toInProgress.status}`);
    const skipAhead = await api(`/api/bookings/${booking3Id}/status`, {
      method: "PATCH", headers: auth(techA.token), body: JSON.stringify({ status: "completed" }),
    });
    check(skipAhead.status === 400, `skipping finalAmount rules rejected -> ${skipAhead.status} (expected 400)`);
    const complete = await api(`/api/bookings/${booking3Id}/status`, {
      method: "PATCH", headers: auth(techA.token), body: JSON.stringify({ status: "completed", finalAmount: 120 }),
    });
    check(complete.status === 200 && complete.body?.data?.status === "completed" && complete.body?.data?.finalAmount === 120, `in-progress -> completed with finalAmount -> ${complete.status}`);

    // --- Booking details ownership ---
    console.log("\n[booking details ownership]");
    const ownerDetail = await api(`/api/bookings/${booking3Id}`, { headers: auth(custC.token) });
    check(ownerDetail.status === 200 && ownerDetail.body?.data?.id === booking3Id, `owner sees their booking -> ${ownerDetail.status}`);
    const otherDetail = await api(`/api/bookings/${booking3Id}`, { headers: auth(custD.token) });
    check(otherDetail.status === 404, `other customer cannot see booking -> ${otherDetail.status} (expected 404)`);
    const techDetail = await api(`/api/bookings/${booking3Id}`, { headers: auth(techA.token) });
    check(techDetail.status === 403, `technician cannot view customer detail endpoint -> ${techDetail.status} (expected 403)`);
    const badId = await api("/api/bookings/not-an-id", { headers: auth(custC.token) });
    check(badId.status === 400, `invalid booking id -> ${badId.status} (expected 400)`);

    // --- Cancellation ownership on a requested booking ---
    console.log("\n[cancellation ownership]");
    const rebook4 = await api("/api/bookings", {
      method: "POST", headers: auth(custC.token),
      body: JSON.stringify({ serviceId: serviceId.toHexString(), problemDescription: "Fourth booking for cancel ownership." }),
    });
    const booking4Id = rebook4.body?.data?._id;
    const custDCancel = await api(`/api/bookings/${booking4Id}/cancel`, {
      method: "PATCH", headers: auth(custD.token), body: "{}",
    });
    check(custDCancel.status === 404, `other customer cannot cancel -> ${custDCancel.status} (expected 404)`);
    const techCancel = await api(`/api/bookings/${booking4Id}/cancel`, {
      method: "PATCH", headers: auth(techA.token), body: "{}",
    });
    check(techCancel.status === 403, `technician cannot cancel -> ${techCancel.status} (expected 403)`);
    const ownerCancel = await api(`/api/bookings/${booking4Id}/cancel`, {
      method: "PATCH", headers: auth(custC.token), body: "{}",
    });
    check(ownerCancel.status === 200 && ownerCancel.body?.data?.status === "cancelled", `owner cancels own requested booking -> ${ownerCancel.status}`);

    // --- Cancelled bookings visibility (default exclusion + explicit filter) ---
    console.log("\n[cancelled visibility]");
    const custDefault = await api("/api/bookings/my?limit=50", { headers: auth(custC.token) });
    const custDefaultIds = (custDefault.body?.data ?? []).map((b) => b._id);
    check(
      custDefault.status === 200 && !custDefaultIds.includes(bookingId) && !custDefaultIds.includes(booking4Id),
      "customer default list excludes cancelled bookings"
    );
    check(
      custDefaultIds.includes(booking2Id) && custDefaultIds.includes(booking3Id),
      "customer default list retains non-cancelled (rejected/completed) bookings"
    );
    const custCancelled = await api("/api/bookings/my?status=cancelled&limit=50", { headers: auth(custC.token) });
    const custCancelIds = (custCancelled.body?.data ?? []).map((b) => b._id);
    check(
      custCancelled.status === 200 && custCancelIds.includes(bookingId) && custCancelIds.includes(booking4Id),
      "customer ?status=cancelled returns only cancelled bookings"
    );
    check(
      !custCancelIds.includes(booking2Id) && !custCancelIds.includes(booking3Id),
      "customer cancelled filter excludes other statuses"
    );
    check(
      custCancelled.body?.pagination?.totalItems === 2,
      `customer cancelled filter totalItems reflects filter (got ${custCancelled.body?.pagination?.totalItems})`
    );
    const custRequested = await api("/api/bookings/my?status=requested&limit=50", { headers: auth(custC.token) });
    check(
      custRequested.status === 200 && (custRequested.body?.data ?? []).every((b) => b.status === "requested"),
      "customer requested filter returns requested only"
    );

    const techDefault = await api("/api/bookings/technician?limit=50", { headers: auth(techA.token) });
    const techDefaultIds = (techDefault.body?.data ?? []).map((b) => b._id);
    check(
      techDefault.status === 200 && !techDefaultIds.includes(bookingId) && !techDefaultIds.includes(booking4Id),
      "technician default list excludes cancelled bookings"
    );
    check(
      techDefaultIds.includes(booking2Id) && techDefaultIds.includes(booking3Id),
      "technician default list retains non-cancelled bookings"
    );
    const techCancelled = await api("/api/bookings/technician?status=cancelled&limit=50", { headers: auth(techA.token) });
    const techCancelIds = (techCancelled.body?.data ?? []).map((b) => b._id);
    check(
      techCancelled.status === 200 && techCancelIds.includes(bookingId) && techCancelIds.includes(booking4Id),
      "technician ?status=cancelled returns only cancelled bookings"
    );
    check(
      !techCancelIds.includes(booking3Id),
      "technician cancelled filter excludes non-cancelled bookings"
    );

    // --- Cancelled bookings isolation (ownership boundaries hold) ---
    console.log("\n[cancelled isolation]");
    const custDCancelled = await api("/api/bookings/my?status=cancelled&limit=50", { headers: auth(custD.token) });
    check(
      custDCancelled.status === 200 && (custDCancelled.body?.data ?? []).length === 0,
      "other customer cannot see custC's cancelled bookings"
    );
    const techBCancelled = await api("/api/bookings/technician?status=cancelled&limit=50", { headers: auth(techB.token) });
    check(
      techBCancelled.status === 200 && (techBCancelled.body?.data ?? []).length === 0,
      "other technician cannot see techA's cancelled bookings"
    );

    // --- Cancelled filter pagination totals ---
    console.log("\n[cancelled pagination]");
    const page1 = await api("/api/bookings/my?status=cancelled&page=1&limit=1", { headers: auth(custC.token) });
    check(
      page1.status === 200 && page1.body?.pagination?.totalItems === 2 && page1.body?.pagination?.totalPages === 2 && page1.body?.pagination?.hasNextPage === true && page1.body?.pagination?.hasPrevPage === false,
      `cancelled page 1: totals reflect filter (totalItems=${page1.body?.pagination?.totalItems}, totalPages=${page1.body?.pagination?.totalPages})`
    );
    const page2 = await api("/api/bookings/my?status=cancelled&page=2&limit=1", { headers: auth(custC.token) });
    check(
      page2.status === 200 && page2.body?.pagination?.hasNextPage === false && page2.body?.pagination?.hasPrevPage === true,
      "cancelled page 2: no next page, has prev page"
    );
    const pageTech = await api("/api/bookings/technician?status=cancelled&page=1&limit=1", { headers: auth(techA.token) });
    check(
      pageTech.status === 200 && pageTech.body?.pagination?.totalItems === 2,
      `technician cancelled filter totalItems reflects filter (got ${pageTech.body?.pagination?.totalItems})`
    );
  } finally {
    await cleanup();
    console.log("\ncleanup: seeded users/bookings/service removed");
    await client.close();
  }

  console.log(`\n${failures === 0 ? "BOOKING FLOW CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("booking-flow test crashed:", e);
  try { await client.close(); } catch {}
  process.exit(1);
});
