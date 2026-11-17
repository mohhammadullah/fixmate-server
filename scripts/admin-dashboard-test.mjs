/**
 * FixMate admin dashboard/users/bookings integration test (development only).
 *
 * Exercises GET /api/admin/dashboard/stats, user listing/detail/role updates
 * and the all-bookings listing against a locally running server with a real
 * MongoDB database. Throwaway users, services and bookings are seeded and
 * removed on completion. Statistics are checked as deltas against a baseline
 * so pre-existing data doesn't invalidate assertions.
 *
 * Role-promotion coverage: anonymous/customer/technician rejection, admin
 * promotion of customers and technicians, strict/invalid input, self-change
 * rejection, profile-endpoint escalation rejection, and the Normal-Admin
 * demotion ban (including a concurrent cross-demotion race) that keeps at
 * least one admin on the platform at all times. The Main Admin ownership
 * rules are covered by scripts/main-admin-test.mjs.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/admin-dashboard-test.mjs
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

const makeUser = async (db, label, role = "customer", applicationStatus = null) => {
  const email = `fixmate.admin.${label}.${Date.now()}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const name = `FixMate Admin ${label}`;
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST", headers,
    body: JSON.stringify({ email, password, name }),
  });
  if (signup.status !== 200 && signup.status !== 201) throw new Error(`signup ${label} failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  if (role !== "customer" || applicationStatus) {
    const users = db.collection("user");
    const set = { role };
    if (applicationStatus) {
      set["technicianApplication.status"] = applicationStatus;
      set["technicianApplication.experience"] = 3;
      set["technicianApplication.skills"] = ["Repair"];
      set["technicianApplication.submittedAt"] = new Date();
    }
    await users.updateOne({ email }, { $set: set });
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
  console.log(`Admin endpoint test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const services = db.collection("services");
  const bookings = db.collection("bookings");

  const admin = await makeUser(db, "admin", "admin");
  const customer = await makeUser(db, "customer");
  const applicant = await makeUser(db, "applicant", "customer", "approved");
  const secondAdmin = await makeUser(db, "admin2", "admin");
  const roletech = await makeUser(db, "roletech", "technician");
  console.log("throwaway users created: admin, customer, applicant, admin2, roletech\n");

  const baselineRes = await api("/api/admin/dashboard/stats", { headers: auth(admin.token) });
  if (baselineRes.status !== 200) throw new Error(`baseline stats failed: ${baselineRes.status}`);
  const base = baselineRes.body.data;

  const serviceIds = [new ObjectId(), new ObjectId()];
  const bookingIds = [new ObjectId(), new ObjectId(), new ObjectId()];
  const now = new Date();
  const baseService = {
    title: "Seeded Admin Test Repair", category: "Mobile Repair", description: "seed description",
    overview: "seed overview", hourlyRate: 50, securityDeposit: 20, maxCapacity: 3,
    location: "Seeded City", image: "", amenities: [], technicianId: new ObjectId(),
    technicianName: "Seeded Tech", technicianEmail: "seed.tech@example.com",
  };
  const baseBooking = {
    customerId: customer.userId,
    customerName: customer.name,
    customerEmail: customer.email,
    technicianId: baseService.technicianId,
    technicianName: "Seeded Tech",
    technicianEmail: "seed.tech@example.com",
    serviceTitle: baseService.title,
    serviceCategory: baseService.category,
    serviceLocation: baseService.location,
    serviceImage: baseService.image,
    hourlyRate: baseService.hourlyRate,
    securityDeposit: baseService.securityDeposit,
    problemDescription: "Seeded booking problem description.",
    paymentStatus: "unpaid",
    createdAt: now,
    updatedAt: now,
  };

  try {
    // --- Authorization ---
    console.log("[authorization]");
    const anon = await api("/api/admin/dashboard/stats");
    check(anon.status === 401, `stats without token -> ${anon.status} (expected 401)`);
    const customerStats = await api("/api/admin/dashboard/stats", { headers: auth(customer.token) });
    check(customerStats.status === 403, `stats as customer -> ${customerStats.status} (expected 403)`);
    const customerUsers = await api("/api/admin/users", { headers: auth(customer.token) });
    check(customerUsers.status === 403, `users as customer -> ${customerUsers.status} (expected 403)`);
    const customerBookings = await api("/api/admin/bookings", { headers: auth(customer.token) });
    check(customerBookings.status === 403, `bookings as customer -> ${customerBookings.status} (expected 403)`);

    // --- Seed data ---
    await services.insertMany([
      { _id: serviceIds[0], ...baseService, approvalStatus: "pending", availabilityStatus: "available", createdAt: now, updatedAt: now },
      { _id: serviceIds[1], ...baseService, approvalStatus: "approved", availabilityStatus: "available", createdAt: now, updatedAt: now },
    ]);
    await bookings.insertMany([
      { _id: bookingIds[0], ...baseBooking, serviceId: new ObjectId(), status: "requested" },
      { _id: bookingIds[1], ...baseBooking, serviceId: new ObjectId(), status: "in-progress", paymentStatus: "paid", finalAmount: 150 },
      { _id: bookingIds[2], ...baseBooking, serviceId: new ObjectId(), status: "cancelled" },
    ]);

    // --- Stats deltas ---
    console.log("\n[dashboard stats]");
    const statsRes = await api("/api/admin/dashboard/stats", { headers: auth(admin.token) });
    check(statsRes.status === 200 && statsRes.body?.success === true, `stats -> ${statsRes.status} (expected 200)`);
    const s = statsRes.body?.data ?? {};
    check(s.totalUsers === base.totalUsers, `totalUsers stable (${base.totalUsers} -> ${s.totalUsers})`);
    check(s.totalServices === base.totalServices + 2, `totalServices delta +2`);
    check(s.pendingServiceApprovals === base.pendingServiceApprovals + 1, "pendingServiceApprovals delta +1");
    check(s.approvedServices === base.approvedServices + 1, "approvedServices delta +1");
    check(s.totalBookings === base.totalBookings + 3, "totalBookings delta +3");
    check(s.requestedBookings === base.requestedBookings + 1, "requestedBookings delta +1");
    check(s.inProgressBookings === base.inProgressBookings + 1, "inProgressBookings delta +1");
    check(s.cancelledBookings === base.cancelledBookings + 1, "cancelledBookings delta +1");
    check(s.pendingTechnicianApplications === base.pendingTechnicianApplications, "pending applications unchanged");
    check(s.totalSuccessfulPaymentAmount === 0, "payment amount honest zero");
    check(typeof s.paymentsAvailable === "boolean", "paymentsAvailable flag present");

    // --- User listing ---
    console.log("\n[user listing]");
    const usersRes = await api("/api/admin/users?page=1&limit=2", { headers: auth(admin.token) });
    check(usersRes.status === 200 && usersRes.body?.data?.length === 2, `users list -> ${usersRes.status}, 2 items`);
    check(usersRes.body?.pagination?.totalItems >= 4, "pagination totalItems present");
    check(usersRes.body?.pagination?.hasNextPage === true, "hasNextPage true");
    const firstUser = usersRes.body?.data?.[0] ?? {};
    check(typeof firstUser.id === "string" && typeof firstUser.email === "string", "safe user fields present");
    const leakedUser = ["password", "passwordHash", "session", "account", "_id", "technicianApplication"].filter((k) => k in firstUser);
    check(leakedUser.length === 0, `user DTO excludes auth internals (found: ${leakedUser.join(", ") || "none"})`);
    const searchRes = await api(`/api/admin/users?search=${encodeURIComponent(customer.email)}`, { headers: auth(admin.token) });
    check(searchRes.status === 200 && searchRes.body?.data?.some((u) => u.id === customer.userId.toHexString()), "search by email finds seeded user");
    const roleFilter = await api("/api/admin/users?role=admin&limit=50", { headers: auth(admin.token) });
    check(roleFilter.status === 200 && roleFilter.body?.data?.every((u) => u.role === "admin"), "role filter returns only admins");
    const badRole = await api("/api/admin/users?role=bogus", { headers: auth(admin.token) });
    check(badRole.status === 400, `invalid role filter -> ${badRole.status} (expected 400)`);

    // --- User detail ---
    console.log("\n[user detail]");
    const detail = await api(`/api/admin/users/${customer.userId.toHexString()}`, { headers: auth(admin.token) });
    check(detail.status === 200 && detail.body?.data?.email === customer.email, "GET user detail -> 200 safe DTO");
    const missing = await api(`/api/admin/users/${new ObjectId().toHexString()}`, { headers: auth(admin.token) });
    check(missing.status === 404, `missing user -> ${missing.status} (expected 404)`);
    const badId = await api("/api/admin/users/not-an-id", { headers: auth(admin.token) });
    check(badId.status === 400, `invalid user id -> ${badId.status} (expected 400)`);

    // --- Role rules ---
    console.log("\n[role updates]");
    const anonRole = await api(`/api/admin/users/${customer.userId}/role`, {
      method: "PATCH", headers, body: JSON.stringify({ role: "technician" }),
    });
    check(anonRole.status === 401, `role change without token -> ${anonRole.status} (expected 401)`);
    const customerRoleChange = await api(`/api/admin/users/${customer.userId}/role`, {
      method: "PATCH", headers: auth(customer.token), body: JSON.stringify({ role: "technician" }),
    });
    check(customerRoleChange.status === 403, `role change as customer -> ${customerRoleChange.status} (expected 403)`);
    const technicianRoleChange = await api(`/api/admin/users/${customer.userId}/role`, {
      method: "PATCH", headers: auth(roletech.token), body: JSON.stringify({ role: "customer" }),
    });
    check(technicianRoleChange.status === 403, `role change as technician -> ${technicianRoleChange.status} (expected 403)`);
    const badTarget = await api("/api/admin/users/not-an-id/role", {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "customer" }),
    });
    check(badTarget.status === 400, `role change with invalid id -> ${badTarget.status} (expected 400)`);
    const missingTarget = await api(`/api/admin/users/${new ObjectId().toHexString()}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "customer" }),
    });
    check(missingTarget.status === 404, `role change for missing user -> ${missingTarget.status} (expected 404)`);
    const profileEscalation = await api("/api/users/me", {
      method: "PATCH", headers: auth(applicant.token), body: JSON.stringify({ role: "admin" }),
    });
    check(profileEscalation.status === 400, `profile endpoint cannot escalate role -> ${profileEscalation.status} (expected 400)`);
    const selfDemote = await api(`/api/admin/users/${admin.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "customer" }),
    });
    check(selfDemote.status === 403, `self role change -> ${selfDemote.status} (expected 403)`);
    const badRoleBody = await api(`/api/admin/users/${customer.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "admin", extra: true }),
    });
    check(badRoleBody.status === 400, `strict role body -> ${badRoleBody.status} (expected 400)`);
    const unapprovedPromote = await api(`/api/admin/users/${customer.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "technician" }),
    });
    check(unapprovedPromote.status === 409, `promote unapproved customer -> ${unapprovedPromote.status} (expected 409)`);
    const promote = await api(`/api/admin/users/${applicant.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "technician" }),
    });
    check(promote.status === 200 && promote.body?.data?.role === "technician", `promote approved applicant -> ${promote.status}`);
    const sameRole = await api(`/api/admin/users/${applicant.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "technician" }),
    });
    check(sameRole.status === 409, `repeat role -> ${sameRole.status} (expected 409)`);

    // --- Admin promotion ---
    console.log("\n[admin promotion]");
    const promoteCustomerToAdmin = await api(`/api/admin/users/${customer.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "admin" }),
    });
    check(promoteCustomerToAdmin.status === 200 && promoteCustomerToAdmin.body?.data?.role === "admin", `admin promotes customer -> ${promoteCustomerToAdmin.status} (expected 200)`);
    const promoteTechToAdmin = await api(`/api/admin/users/${applicant.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "admin" }),
    });
    check(promoteTechToAdmin.status === 200 && promoteTechToAdmin.body?.data?.role === "admin", `admin promotes technician -> ${promoteTechToAdmin.status} (expected 200)`);

    // --- Admin demotion hierarchy (Normal Admins can never demote) ---
    console.log("\n[admin demotion hierarchy]");
    const demoteSecondAdmin = await api(`/api/admin/users/${secondAdmin.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "customer" }),
    });
    check(demoteSecondAdmin.status === 403, `normal admin demotes second admin -> ${demoteSecondAdmin.status} (expected 403)`);
    const demotePromotedCustomer = await api(`/api/admin/users/${customer.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "customer" }),
    });
    check(demotePromotedCustomer.status === 403, `normal admin demotes promoted admin -> ${demotePromotedCustomer.status} (expected 403)`);
    const demotePromotedTech = await api(`/api/admin/users/${applicant.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "customer" }),
    });
    check(demotePromotedTech.status === 403, `normal admin demotes promoted admin -> ${demotePromotedTech.status} (expected 403)`);
    const repeatAdminPromotion = await api(`/api/admin/users/${applicant.userId}/role`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "admin" }),
    });
    check(repeatAdminPromotion.status === 409, `repeat admin promotion -> ${repeatAdminPromotion.status} (expected 409)`);

    // Cross-demotion race: two admins demote each other at once. Normal
    // Admins can never demote admins, so both requests get 403 — no admin
    // can ever be removed by a non-Main-Admin, whatever the count.
    const raceSignin = await api("/api/auth/sign-in/email", {
      method: "POST", headers, body: JSON.stringify({ email: customer.email, password: customer.password }),
    });
    const raceCookie = (raceSignin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
    const raceTokenRes = await api("/api/auth/token", { headers: { cookie: raceCookie } });
    const customerAdminToken = raceTokenRes.body?.token;
    if (!customerAdminToken) throw new Error("could not obtain admin token for race test");
    const [demoteA, demoteB] = await Promise.all([
      api(`/api/admin/users/${customer.userId}/role`, {
        method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ role: "customer" }),
      }),
      api(`/api/admin/users/${admin.userId}/role`, {
        method: "PATCH", headers: auth(customerAdminToken), body: JSON.stringify({ role: "customer" }),
      }),
    ]);
    check(demoteA.status === 403 && demoteB.status === 403, `cross-demotion rejected for normal admins -> ${demoteA.status}/${demoteB.status} (expected 403/403)`);
    check(demoteA.status !== 500 && demoteB.status !== 500, "cross-demotion did not error out");
    const adminsLeft = await users.countDocuments({ role: "admin" });
    check(adminsLeft >= 4, `all four throwaway admins remain after the race (got ${adminsLeft})`);
    const actorStillAdmin = await users.findOne({ _id: admin.userId }, { projection: { role: 1 } });
    check(actorStillAdmin?.role === "admin", "actor remains admin after the race");

    // --- All bookings ---
    console.log("\n[all bookings]");
    const bookingsRes = await api("/api/admin/bookings?page=1&limit=2", { headers: auth(admin.token) });
    check(bookingsRes.status === 200 && bookingsRes.body?.data?.length === 2, `bookings list -> ${bookingsRes.status}, 2 items`);
    check(bookingsRes.body?.pagination?.hasNextPage === true, "bookings hasNextPage true");
    const oneBooking = bookingsRes.body?.data?.[0] ?? {};
    check(typeof oneBooking.id === "string" && typeof oneBooking.serviceTitle === "string", "safe booking fields present");
    const leakedBooking = ["customerId", "technicianId", "serviceId", "_id"].filter((k) => k in oneBooking);
    check(leakedBooking.length === 0, `booking DTO excludes internal ids (found: ${leakedBooking.join(", ") || "none"})`);
    const statusFilter = await api("/api/admin/bookings?status=in-progress&limit=50", { headers: auth(admin.token) });
    check(statusFilter.status === 200 && statusFilter.body?.data?.some((b) => b.status === "in-progress"), "status filter works");
    const paymentFilter = await api("/api/admin/bookings?paymentStatus=paid&limit=50", { headers: auth(admin.token) });
    check(paymentFilter.status === 200 && paymentFilter.body?.data?.some((b) => b.paymentStatus === "paid"), "paymentStatus filter works");
    const badBookingStatus = await api("/api/admin/bookings?status=bogus", { headers: auth(admin.token) });
    check(badBookingStatus.status === 400, `invalid booking status -> ${badBookingStatus.status} (expected 400)`);
    const searchBookings = await api(`/api/admin/bookings?search=${encodeURIComponent("Seeded Admin Test Repair")}&limit=50`, { headers: auth(admin.token) });
    check(searchBookings.status === 200 && searchBookings.body?.data?.some((b) => b.serviceTitle === "Seeded Admin Test Repair"), "booking search works");
  } finally {
    await users.deleteMany({ _id: { $in: [admin.userId, customer.userId, applicant.userId, secondAdmin.userId, roletech.userId] } });
    await db.collection("session").deleteMany({ userId: { $in: [admin.userId, customer.userId, applicant.userId, secondAdmin.userId, roletech.userId].map(String) } });
    await db.collection("account").deleteMany({ userId: { $in: [admin.userId, customer.userId, applicant.userId, secondAdmin.userId, roletech.userId].map(String) } });
    await services.deleteMany({ _id: { $in: serviceIds } });
    await bookings.deleteMany({ _id: { $in: bookingIds } });
    console.log("\ncleanup: throwaway users, services and bookings removed");
    await client.close();
  }

  console.log(`\n${failures === 0 ? "ADMIN ENDPOINT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("admin test crashed:", e);
  try { await client.close(); } catch {}
  process.exit(1);
});
