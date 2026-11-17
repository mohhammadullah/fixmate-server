/**
 * FixMate admin service moderation integration test (development only).
 *
 * Verifies GET /api/admin/services (admin-only pending queue with filters,
 * pagination and safe DTOs) plus the existing PATCH /:id/approve and
 * PATCH /:id/reject moderation endpoints, including invalid transitions.
 * Throwaway users and services are seeded and removed on completion.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/admin-services-test.mjs
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
  const email = `fixmate.adminsvc.${label}.${Date.now()}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST", headers, body: JSON.stringify({ email, password, name: `FixMate AdminSvc ${label}` }),
  });
  if (signup.status !== 200 && signup.status !== 201) throw new Error(`signup ${label}: ${signup.status}`);
  if (role !== "customer") await db.collection("user").updateOne({ email }, { $set: { role } });
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST", headers, body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) throw new Error(`signin ${label}: ${signin.status}`);
  const cookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
  const tokenRes = await api("/api/auth/token", { headers: { cookie } });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") throw new Error(`token ${label}: ${tokenRes.status}`);
  const user = await db.collection("user").findOne({ email });
  return { email, userId: user._id, token: tokenRes.body.token };
};

const main = async () => {
  console.log(`Admin service moderation test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const services = db.collection("services");

  const admin = await makeUser(db, "admin", "admin");
  const customer = await makeUser(db, "customer");
  const technician = await makeUser(db, "technician", "technician");
  console.log("throwaway users created\n");
  const techId = technician.userId;
  const serviceIds = [new ObjectId(), new ObjectId(), new ObjectId()];
  const now = new Date();
  const baseService = {
    title: "Seeded Admin Service", category: "Laptop Repair", description: "seed description",
    overview: "seed overview", hourlyRate: 60, securityDeposit: 30, maxCapacity: 4,
    location: "Seeded Town", image: "", amenities: ["Home visit", "Warranty"],
    technicianId: techId, technicianName: "Seeded Moderator Tech", technicianEmail: "seed.tech@example.com",
    availabilityStatus: "available", createdAt: now, updatedAt: now,
  };

  try {
    await services.insertMany([
      { _id: serviceIds[0], ...baseService, approvalStatus: "pending" },
      { _id: serviceIds[1], ...baseService, approvalStatus: "pending", title: "Seeded Approved Service" },
      { _id: serviceIds[2], ...baseService, approvalStatus: "rejected", title: "Seeded Rejected Service", rejectionReason: "Old reason." },
    ]);

    // --- Authorization ---
    console.log("[authorization]");
    const anon = await api("/api/admin/services");
    check(anon.status === 401, `listing without token -> ${anon.status} (expected 401)`);
    const asCustomer = await api("/api/admin/services", { headers: auth(customer.token) });
    check(asCustomer.status === 403, `listing as customer -> ${asCustomer.status} (expected 403)`);
    const asTechnician = await api("/api/admin/services", { headers: auth(technician.token) });
    check(asTechnician.status === 403, `listing as technician -> ${asTechnician.status} (expected 403)`);

    // --- Listing / filters / pagination / DTO ---
    console.log("\n[listing]");
    const pending = await api("/api/admin/services?page=1&limit=1", { headers: auth(admin.token) });
    check(pending.status === 200 && pending.body?.success === true, `default listing -> ${pending.status} (expected 200)`);
    check(pending.body?.data?.every((s) => s.approvalStatus === "pending"), "default listing returns only pending services");
    check(pending.body?.pagination?.totalItems >= 1, "pagination totalItems present");
    check(pending.body?.pagination?.hasNextPage === (pending.body?.pagination?.totalItems > 1), "pagination hasNextPage matches remaining results");
    const dto = pending.body?.data?.[0] ?? {};
    for (const key of ["title", "category", "location", "hourlyRate", "securityDeposit", "maxCapacity", "amenities", "overview", "image", "technicianName", "technicianEmail", "createdAt"]) {
      check(key in dto, `DTO includes ${key}`);
    }
    const leaked = ["technicianId", "password", "passwordHash", "session", "_id"].filter((key) => key in dto);
    check(leaked.length === 0, `DTO excludes internal/account fields (found: ${leaked.join(", ") || "none"})`);
    const approved = await api("/api/admin/services?status=approved&limit=50", { headers: auth(admin.token) });
    check(approved.status === 200 && approved.body?.data?.every((s) => s.approvalStatus === "approved"), "status=approved filter works");
    const rejected = await api("/api/admin/services?status=rejected&limit=50", { headers: auth(admin.token) });
    check(rejected.status === 200 && rejected.body?.data?.every((s) => s.approvalStatus === "rejected"), "status=rejected filter works");
    const searched = await api(`/api/admin/services?status=pending&search=${encodeURIComponent("Seeded Approved Service")}`, { headers: auth(admin.token) });
    check(searched.status === 200 && searched.body?.data?.some((s) => s.id === serviceIds[1].toHexString()), "search finds service by title");
    const badStatus = await api("/api/admin/services?status=bogus", { headers: auth(admin.token) });
    check(badStatus.status === 400, `invalid status filter -> ${badStatus.status} (expected 400)`);
    const badPage = await api("/api/admin/services?page=0", { headers: auth(admin.token) });
    check(badPage.status === 400, `page=0 -> ${badPage.status} (expected 400)`);

    // --- Moderation actions ---
    console.log("\n[moderation]");
    const badId = await api(`/api/services/not-an-id/approve`, { method: "PATCH", headers: auth(admin.token) });
    check(badId.status === 400, `approve invalid id -> ${badId.status} (expected 400)`);
    const missing = await api(`/api/services/${new ObjectId().toHexString()}/approve`, { method: "PATCH", headers: auth(admin.token) });
    check(missing.status === 404, `approve missing service -> ${missing.status} (expected 404)`);
    const rejectNoReason = await api(`/api/services/${serviceIds[0].toHexString()}/reject`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({}),
    });
    check(rejectNoReason.status === 400, `reject without reason -> ${rejectNoReason.status} (expected 400)`);
    const reject = await api(`/api/services/${serviceIds[0].toHexString()}/reject`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ rejectionReason: "Needs clearer overview." }),
    });
    check(reject.status === 200 && reject.body?.data?.approvalStatus === "rejected", `reject -> ${reject.status} (expected 200)`);
    check(reject.body?.data?.rejectionReason === "Needs clearer overview.", "rejection reason stored");
    const rejectAgain = await api(`/api/services/${serviceIds[0].toHexString()}/reject`, {
      method: "PATCH", headers: auth(admin.token), body: JSON.stringify({ rejectionReason: "Again." }),
    });
    check(rejectAgain.status === 409, `reject already rejected -> ${rejectAgain.status} (expected 409)`);
    const approve = await api(`/api/services/${serviceIds[1].toHexString()}/approve`, {
      method: "PATCH", headers: auth(admin.token),
    });
    check(approve.status === 200 && approve.body?.data?.approvalStatus === "approved", `approve -> ${approve.status} (expected 200)`);
    const approveAgain = await api(`/api/services/${serviceIds[1].toHexString()}/approve`, {
      method: "PATCH", headers: auth(admin.token),
    });
    check(approveAgain.status === 409, `approve already approved -> ${approveAgain.status} (expected 409)`);
    const customerApprove = await api(`/api/services/${serviceIds[2].toHexString()}/approve`, {
      method: "PATCH", headers: auth(customer.token),
    });
    check(customerApprove.status === 403, `approve as customer -> ${customerApprove.status} (expected 403)`);
  } finally {
    await services.deleteMany({ _id: { $in: serviceIds } });
    for (const user of [admin, customer, technician]) {
      await db.collection("user").deleteOne({ _id: user.userId });
      await db.collection("session").deleteMany({ userId: user.userId.toHexString() });
      await db.collection("account").deleteMany({ userId: user.userId.toHexString() });
    }
    console.log("\ncleanup: throwaway users and services removed");
    await client.close();
  }

  console.log(`\n${failures === 0 ? "ADMIN-SERVICES CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("admin-services test crashed:", e);
  try { await client.close(); } catch {}
  process.exit(1);
});
