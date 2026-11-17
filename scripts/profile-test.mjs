/**
 * FixMate profile endpoint integration test (development only).
 *
 * Verifies GET/PATCH /api/users/me end-to-end against a locally running
 * server with a real MongoDB database: authentication, safe DTO, successful
 * updates, trimming, validation errors, strict rejection of role/email/
 * application fields, user isolation, 404 for a deleted account, and the
 * technician-application status surfaced without review internals.
 * Throwaway accounts are created through public signup and removed.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/profile-test.mjs
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

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
  const email = `fixmate.profile.${label}.${Date.now()}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const name = `FixMate Profile ${label}`;
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST", headers, body: JSON.stringify({ email, password, name }),
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
  return { email, password, name, userId: user._id, token: tokenRes.body.token, sessionCookie: cookie };
};

const main = async () => {
  console.log(`Profile endpoint test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");

  const a = await makeUser(db, "a");
  const b = await makeUser(db, "b");
  const technician = await makeUser(db, "technician", "technician");
  const admin = await makeUser(db, "admin", "admin");
  console.log("throwaway users created: a, b, technician, admin\n");

  try {
    // --- Authentication ---
    console.log("[authentication]");
    const anonGet = await api("/api/users/me");
    check(anonGet.status === 401, `GET /me without token -> ${anonGet.status} (expected 401)`);
    const anonPatch = await api("/api/users/me", { method: "PATCH", headers, body: JSON.stringify({ name: "X" }) });
    check(anonPatch.status === 401, `PATCH /me without token -> ${anonPatch.status} (expected 401)`);

    // --- Safe DTO for all roles ---
    console.log("\n[profile DTO]");
    for (const [label, account, expectedRole] of [
      ["customer", a, "customer"],
      ["technician", technician, "technician"],
      ["admin", admin, "admin"],
    ]) {
      const res = await api("/api/users/me", { headers: auth(account.token) });
      const dto = res.body?.data ?? {};
      const expectedKeys = ["id", "name", "email", "role", "phone", "area", "bio", "createdAt", "updatedAt"];
      const missing = expectedKeys.filter((key) => !(key in dto));
      check(res.status === 200 && missing.length === 0, `${label} profile has safe fields (missing: ${missing.join(", ") || "none"})`);
      check(dto.role === expectedRole && dto.email === account.email, `${label} role/email correct`);
      const leaked = ["password", "passwordHash", "session", "account", "_id", "technicianApplication", "reviewedBy", "rejectionReason"].filter((key) => key in dto);
      check(leaked.length === 0, `${label} DTO excludes internals (found: ${leaked.join(", ") || "none"})`);
    }

    // Application status is surfaced without review internals.
    await users.updateOne(
      { _id: technician.userId },
      { $set: {
        "technicianApplication.status": "approved",
        "technicianApplication.reviewedBy": admin.userId,
        "technicianApplication.rejectionReason": "internal",
        "technicianApplication.skills": ["Repair"],
      } }
    );
    const withApp = await api("/api/users/me", { headers: auth(technician.token) });
    check(withApp.body?.data?.technicianApplicationStatus === "approved", "application status exposed");
    const reviewLeak = ["reviewedBy", "rejectionReason", "skills", "experience", "submittedAt"].filter((key) => key in (withApp.body?.data ?? {}));
    check(reviewLeak.length === 0, `review internals not exposed (found: ${reviewLeak.join(", ") || "none"})`);

    // --- Successful update ---
    console.log("\n[update]");
    const updated = await api("/api/users/me", {
      method: "PATCH",
      headers: auth(a.token),
      body: JSON.stringify({ name: "  Updated Customer  ", phone: " +1 555 123 4567 ", area: " Central ", bio: "  Updated bio text for the profile test.  " }),
    });
    check(updated.status === 200 && updated.body?.data?.name === "Updated Customer", `update -> ${updated.status}, trimmed name`);
    check(updated.body?.data?.phone === "+1 555 123 4567" && updated.body?.data?.area === "Central", "phone/area trimmed and stored");
    const persisted = await users.findOne({ _id: a.userId });
    check(persisted?.name === "Updated Customer" && persisted?.bio === "Updated bio text for the profile test.", "changes persisted in Better Auth user document");

    // --- Validation ---
    console.log("\n[validation]");
    const empty = await api("/api/users/me", { method: "PATCH", headers: auth(a.token), body: JSON.stringify({}) });
    check(empty.status === 400, `empty update -> ${empty.status} (expected 400)`);
    const emptyName = await api("/api/users/me", { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ name: "   " }) });
    check(emptyName.status === 400, `blank name -> ${emptyName.status} (expected 400)`);
    const badPhone = await api("/api/users/me", { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ phone: "call me maybe" }) });
    check(badPhone.status === 400, `invalid phone -> ${badPhone.status} (expected 400)`);
    const longBio = await api("/api/users/me", { method: "PATCH", headers: auth(a.token), body: JSON.stringify({ bio: "x".repeat(1001) }) });
    check(longBio.status === 400, `overlong bio -> ${longBio.status} (expected 400)`);

    // --- Strict rejection of privileged fields ---
    console.log("\n[privilege escalation]");
    for (const [field, value] of [
      ["role", "admin"],
      ["email", "attacker@example.com"],
      ["technicianApplication", { status: "approved" }],
      ["_id", "000000000000000000000000"],
    ]) {
      const res = await api("/api/users/me", {
        method: "PATCH", headers: auth(a.token), body: JSON.stringify({ [field]: value }),
      });
      check(res.status === 400, `${field} in update body -> ${res.status} (expected 400)`);
    }
    const mixed = await api("/api/users/me", {
      method: "PATCH", headers: auth(a.token), body: JSON.stringify({ name: "Sneaky", role: "admin" }),
    });
    check(mixed.status === 400, `mixed role field -> ${mixed.status} (expected 400 strict)`);
    const afterEscalation = await users.findOne({ _id: a.userId });
    check(afterEscalation?.role === "customer" && afterEscalation?.email === a.email, "role and email unchanged");

    // --- User isolation ---
    console.log("\n[isolation]");
    const bBefore = await users.findOne({ _id: b.userId });
    await api("/api/users/me", { method: "PATCH", headers: auth(b.token), body: JSON.stringify({ area: "North District" }) });
    const aAfter = await users.findOne({ _id: a.userId });
    check(aAfter?.area === "Central" && bBefore?.area !== "North District", "updating B does not change A");
    const bProfile = await api("/api/users/me", { headers: auth(b.token) });
    check(bProfile.body?.data?.area === "North District", "B sees their own update");

    // --- Missing account ---
    console.log("\n[missing account]");
    await users.deleteOne({ _id: b.userId });
    const deletedGet = await api("/api/users/me", { headers: auth(b.token) });
    check(deletedGet.status === 404, `GET /me after account deletion -> ${deletedGet.status} (expected 404)`);
    const deletedPatch = await api("/api/users/me", { method: "PATCH", headers: auth(b.token), body: JSON.stringify({ name: "Ghost" }) });
    check(deletedPatch.status === 404, `PATCH /me after account deletion -> ${deletedPatch.status} (expected 404)`);
  } finally {
    const ids = [a.userId, technician.userId, admin.userId];
    await users.deleteMany({ _id: { $in: ids } });
    await db.collection("session").deleteMany({ userId: { $in: ids.map(String) } });
    await db.collection("account").deleteMany({ userId: { $in: ids.map(String) } });
    console.log("\ncleanup: throwaway users removed");
    await client.close();
  }

  console.log(`\n${failures === 0 ? "PROFILE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("profile test crashed:", e);
  try { await client.close(); } catch {}
  process.exit(1);
});
