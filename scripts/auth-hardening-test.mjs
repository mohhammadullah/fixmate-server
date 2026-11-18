/**
 * FixMate auth-hardening integration test (development only).
 *
 * Verifies the production /api/test/* guard and the stale-JWT role policy
 * introduced in src/app.ts / src/middleware/verifyToken.ts.
 *
 * Non-production (default):
 *   - Role demotion in MongoDB is picked up even by JWTs issued before the
 *     change — role-gated endpoints reject accordingly.
 *   - Unknown roles and missing accounts fail closed.
 *
 * Production (--prod through with-isolated-app.mjs):
 *   - /api/test/* endpoints are unmounted (404); /api/health still works.
 *
 * Throwaway users are seeded and removed on completion.
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage:
 *   node scripts/with-isolated-app.mjs scripts/auth-hardening-test.mjs
 *   node scripts/with-isolated-app.mjs scripts/auth-hardening-test.mjs --prod
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const IS_PROD = process.env.NODE_ENV === "production";

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
  const email = `fixmate.hardening.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST", headers,
    body: JSON.stringify({ email, password, name: `Harden ${label}` }),
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
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`token ${label} failed`);
  }
  const user = await db.collection("user").findOne({ email });
  return { email, password, userId: user._id, token: tokenRes.body.token };
};

const cleanupUsers = async (db, users) => {
  const ids = users.map((u) => u.userId);
  if (ids.length === 0) return;
  await db.collection("user").deleteMany({ _id: { $in: ids } });
  await db.collection("session").deleteMany({ userId: { $in: ids } });
  await db.collection("account").deleteMany({ userId: { $in: ids } });
};

const main = async () => {
  console.log(`Auth-hardening test against ${BASE_URL} (NODE_ENV=${process.env.NODE_ENV ?? "unspecified"})\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");

  // --- Production surface: everything under /api/test stays mounted or 404s ---
  if (IS_PROD) {
    console.log("[production: /api/test is not mounted]");
    for (const path of ["/api/test/public", "/api/test/protected", "/api/test/customer", "/api/test/technician", "/api/test/admin"]) {
      const res = await api(path);
      check(res.status === 404, `${path} -> ${res.status} (expected 404)`);
    }
    const health = await api("/api/health");
    check(health.status === 200 && health.body?.success === true, `/api/health -> ${health.status} (expected 200)`);
    await client.close();
    console.log(`\n${failures === 0 ? "PRODUCTION CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const owner = await makeUser(db, "owner", "customer");
  const technician = await makeUser(db, "tech", "technician");
  const admin = await makeUser(db, "admin", "admin");
  const admin2 = await makeUser(db, "admin2", "admin");
  const mainAdmin = await makeUser(db, "main", "admin");
  await users.updateOne({ _id: mainAdmin.userId }, { $set: { isMainAdmin: true } });
  console.log("throwaway users created: owner, technician, admin, admin2, mainAdmin\n");

  try {
    // --- Sanity: roles work as issued ---
    console.log("[fresh-issue roles work]");
    const customerOk = await api("/api/test/customer", { headers: auth(owner.token) });
    check(customerOk.status === 200, `customer can reach /api/test/customer -> ${customerOk.status}`);
    const techOk = await api("/api/test/technician", { headers: auth(technician.token) });
    check(techOk.status === 200, `technician can reach /api/test/technician -> ${techOk.status}`);
    const adminOk = await api("/api/test/admin", { headers: auth(admin.token) });
    check(adminOk.status === 200, `admin can reach /api/test/admin -> ${adminOk.status}`);

    // --- Demote admin to customer in DB; old JWT must lose admin powers ---
    console.log("\n[stale JWT: admin demoted to customer]");
    await users.updateOne({ _id: admin.userId }, { $set: { role: "customer" } });
    const staleAdmin = await api("/api/test/admin", { headers: auth(admin.token) });
    check(staleAdmin.status === 403, `stale admin JWT rejected at /api/test/admin -> ${staleAdmin.status} (expected 403)`);
    const staleAdminUsers = await api("/api/admin/users", { headers: auth(admin.token) });
    check(staleAdminUsers.status === 403, `stale admin JWT rejected at /api/admin/users -> ${staleAdminUsers.status} (expected 403)`);
    const staleAdminStats = await api("/api/admin/dashboard/stats", { headers: auth(admin.token) });
    check(staleAdminStats.status === 403, `stale admin JWT rejected at /api/admin/dashboard/stats -> ${staleAdminStats.status} (expected 403)`);

    // --- Demote technician to customer; old JWT must lose technician powers ---
    console.log("\n[stale JWT: technician demoted to customer]");
    await users.updateOne({ _id: technician.userId }, { $set: { role: "customer" } });
    const staleTech = await api("/api/test/technician", { headers: auth(technician.token) });
    check(staleTech.status === 403, `stale technician JWT rejected at /api/test/technician -> ${staleTech.status} (expected 403)`);

    // --- Demote main admin's isMainAdmin flag only; old JWT still has role
    //     "admin". The endpoint handlers must re-check the DB flag. ---
    console.log("\n[stale JWT: main admin flag removed, role still admin]");
    await users.updateOne({ _id: mainAdmin.userId }, { $set: { isMainAdmin: false } });
    const staleTransfer = await api("/api/admin/main-admin/transfer", {
      method: "POST", headers: auth(mainAdmin.token),
      body: JSON.stringify({ targetUserId: admin.userId.toHexString(), password: crypto.randomUUID() }),
    });
    check(staleTransfer.status === 403, `stale Main Admin JWT rejected at /api/admin/main-admin/transfer -> ${staleTransfer.status} (expected 403)`);
    const staleRoleChange = await api(`/api/admin/users/${admin2.userId.toHexString()}/role`, {
      method: "PATCH", headers: auth(mainAdmin.token), body: JSON.stringify({ role: "customer" }),
    });
    check(staleRoleChange.status === 403, `stale Main Admin JWT rejected at /api/admin/users/:id/role -> ${staleRoleChange.status} (expected 403)`);
    const staleList = await api("/api/admin/users", { headers: auth(mainAdmin.token) });
    check(staleList.status === 200, `stale Main Admin JWT still passes admin list (correct: isMainAdmin not required there) -> ${staleList.status}`);

    // --- Demote main admin fully: role -> customer ---
    console.log("\n[stale JWT: main admin demoted to customer]");
    await users.updateOne({ _id: mainAdmin.userId }, { $set: { role: "customer", isMainAdmin: false } });
    const staleTransfer2 = await api("/api/admin/main-admin/transfer", {
      method: "POST", headers: auth(mainAdmin.token),
      body: JSON.stringify({ targetUserId: admin.userId.toHexString(), password: crypto.randomUUID() }),
    });
    check(staleTransfer2.status === 403, `fully demoted JWT rejected at /api/admin/main-admin/transfer -> ${staleTransfer2.status} (expected 403)`);
    const staleRoleChange2 = await api(`/api/admin/users/${admin2.userId.toHexString()}/role`, {
      method: "PATCH", headers: auth(mainAdmin.token), body: JSON.stringify({ role: "customer" }),
    });
    check(staleRoleChange2.status === 403, `fully demoted JWT rejected at /api/admin/users/:id/role -> ${staleRoleChange2.status} (expected 403)`);

    // --- Fail closed: unknown role ---
    console.log("\n[unknown role fails closed]");
    await users.updateOne({ _id: owner.userId }, { $set: { role: "invisible-role" } });
    const unknownCustomer = await api("/api/test/customer", { headers: auth(owner.token) });
    check(unknownCustomer.status === 403, `unknown role rejected at /api/test/customer -> ${unknownCustomer.status} (expected 403)`);
    const unknownTechnician = await api("/api/test/technician", { headers: auth(owner.token) });
    check(unknownTechnician.status === 403, `unknown role rejected at /api/test/technician -> ${unknownTechnician.status} (expected 403)`);
    const unknownAdmin = await api("/api/test/admin", { headers: auth(owner.token) });
    check(unknownAdmin.status === 403, `unknown role rejected at /api/test/admin -> ${unknownAdmin.status} (expected 403)`);

    // --- Fail closed: deleted account ---
    console.log("\n[missing account fails closed]");
    await users.deleteOne({ _id: owner.userId });
    await db.collection("session").deleteMany({ userId: owner.userId });
    await db.collection("account").deleteMany({ userId: owner.userId });
    const missing = await api("/api/test/protected", { headers: auth(owner.token) });
    check(missing.status === 401, `deleted account rejected at /api/test/protected -> ${missing.status} (expected 401)`);

    // --- Normal requester keeps access (fresh normal user) ---
    console.log("\n[normal requester keeps access]");
    const normal = await makeUser(db, "normal", "customer");
    const normalCustomer = await api("/api/test/customer", { headers: auth(normal.token) });
    check(normalCustomer.status === 200, `normal customer keeps access -> ${normalCustomer.status}`);
    const normalMe = await api("/api/users/me", { headers: auth(normal.token) });
    check(normalMe.status === 200, `normal customer reads own profile -> ${normalMe.status}`);
    const normalMyBookings = await api("/api/bookings/my", { headers: auth(normal.token) });
    check(normalMyBookings.status === 200, `normal customer reads own bookings -> ${normalMyBookings.status}`);

    await cleanupUsers(db, [owner, technician, admin, admin2, mainAdmin, normal]);
  } catch (error) {
    console.error("suite error:", error);
    await cleanupUsers(db, [owner, technician, admin, admin2, mainAdmin]);
    await client.close();
    process.exit(1);
  }

  await client.close();
  console.log(`\n${failures === 0 ? "AUTH-HARDENING CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error("auth-hardening test crashed:", e);
  process.exit(1);
});
