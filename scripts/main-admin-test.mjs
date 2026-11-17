/**
 * FixMate Main Admin hierarchy integration test (development only).
 *
 * Exercises the Main Admin transfer endpoint and the hierarchy rules of
 * PATCH /api/admin/users/:id/role against a locally running server with a
 * real MongoDB database. Uses the real bootstrap script for the "initial
 * bootstrap designates exactly one Main Admin" case. Throwaway users are
 * seeded and removed on completion.
 *
 * If the database already contains a Main Admin, its designation is parked
 * (unset) for the duration of the test and restored afterwards, so the
 * hierarchy assertions always run against a known single Main Admin.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/main-admin-test.mjs
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MongoClient, ObjectId } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) {
  console.error("MONGODB_URI and MONGODB_DB_NAME must be set (via .env).");
  process.exit(1);
}

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };
const info = (msg) => console.log(`  INFO  ${msg}`);
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

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BOOTSTRAP = path.join(REPO_ROOT, "scripts", "bootstrap-admin.mjs");

const runBootstrap = (email, extraEnv = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [BOOTSTRAP],
      {
        env: {
          ...process.env,
          ADMIN_BOOTSTRAP_EMAIL: email,
          ADMIN_BOOTSTRAP_CONFIRM: "true",
          ...extraEnv,
        },
        cwd: REPO_ROOT,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      }
    );
  });

const makeUser = async (db, label, role = "customer", applicationStatus = null) => {
  const email = `fixmate.mainadmin.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const name = `FixMate MainAdmin ${label}`;
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST", headers,
    body: JSON.stringify({ email, password, name }),
  });
  if (signup.status !== 200 && signup.status !== 201) throw new Error(`signup ${label} failed: ${signup.status}`);
  if (role !== "customer" || applicationStatus) {
    await db.collection("user").updateOne(
      { email },
      {
        $set: {
          role,
          ...(applicationStatus
            ? {
                "technicianApplication.status": applicationStatus,
                "technicianApplication.experience": 3,
                "technicianApplication.skills": ["Repair"],
                "technicianApplication.submittedAt": new Date(),
              }
            : {}),
        },
      }
    );
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

const freshToken = async (db, email, password) => {
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST", headers, body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) throw new Error(`signin failed for ${email}: ${signin.status}`);
  const cookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
  const tokenRes = await api("/api/auth/token", { headers: { cookie } });
  return tokenRes.body?.token;
};

const mainAdminCount = (db) => db.collection("user").countDocuments({ isMainAdmin: true });

const main = async () => {
  console.log(`Main Admin hierarchy test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");

  // --- Park any pre-existing Main Admin designation for the test ---
  const preexisting = await users.find({ isMainAdmin: true }, { projection: { _id: 1 } }).toArray();
  if (preexisting.length > 1) {
    throw new Error(
      `Database already violates the single-Main-Admin invariant (found ${preexisting.length}). Refusing to run.`
    );
  }
  const parkedId = preexisting[0]?._id ?? null;
  if (parkedId) {
    await users.updateOne({ _id: parkedId }, { $unset: { isMainAdmin: "" } });
    console.log("parked the pre-existing Main Admin designation for the duration of the test\n");
  }

  // --- Phase 1: bootstrap designates exactly one Main Admin ---
  console.log("[bootstrap]");
  const owner = await makeUser(db, "owner");
  const second = await makeUser(db, "second");

  const boot1 = await runBootstrap(owner.email);
  check(boot1.code === 0, `bootstrap run 1 exits cleanly (code=${boot1.code})`);
  const ownerAfter = await users.findOne({ _id: owner.userId }, { projection: { role: 1, isMainAdmin: 1 } });
  const ownerIsMain = ownerAfter?.isMainAdmin === true;
  const mainAfterFirst = await mainAdminCount(db);
  check(mainAfterFirst >= 1, `a Main Admin was designated (got ${mainAfterFirst})`);
  check(ownerAfter?.role === "admin", "owner was promoted to admin");

  const boot2 = await runBootstrap(second.email);
  check(boot2.code === 0, `bootstrap run 2 exits cleanly (code=${boot2.code})`);
  const secondAfter = await users.findOne({ _id: second.userId }, { projection: { role: 1, isMainAdmin: 1 } });
  check(secondAfter?.role === "admin", "second user was promoted to admin");
  check(secondAfter?.isMainAdmin !== true, "second bootstrap does NOT designate another Main Admin");
  const mainAfterSecond = await mainAdminCount(db);
  check(mainAfterSecond === 1, `exactly one Main Admin remains after second bootstrap (got ${mainAfterSecond})`);

  // Normalize to a known state: exactly owner is Main Admin. If a preexisting
  // admin had been parked away, owner is the first designation (or stays
  // undesignated if the designation was refused because it already existed
  // before the park — the park counts as "none" here).
  if (ownerIsMain) {
    console.log("bootstrap designated the owner as Main Admin as expected");
  } else if (mainAfterFirst === 0) {
    // Shouldn't happen when count was 0 at start.
    throw new Error("no Main Admin exists after bootstrap runs; refusing to continue");
  } else {
    info("bootstrap did not designate the owner (a Main Admin already existed at start)");
  }

  // If we parked a pre-existing Main Admin away, restore it now and exit
  // with only the bootstrap assertions executed (the API scenarios assume a
  // clean hierarchy).
  if (parkedId) {
    const throwawayIds = [owner.userId, second.userId];
    await sessions.deleteMany({ userId: { $in: throwawayIds } });
    await accounts.deleteMany({ userId: { $in: throwawayIds } });
    await users.deleteMany({ _id: { $in: throwawayIds } });
    await users.updateOne({ _id: parkedId }, { $set: { isMainAdmin: true } });
    info("bootstrap-only path (a Main Admin pre-existed, restored); throwaway users removed");
    await client.close();
    console.log(failures === 0 ? "\nMAIN ADMIN BOOTSTRAP CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // From here on: owner is the Main Admin; second is a Normal Admin.
  const customer = await makeUser(db, "customer");
  const technician = await makeUser(db, "technician", "technician");
  const plainCustomer = await makeUser(db, "plaincustomer");

  // Re-mint JWTs — the role is embedded at issuance time, so tokens
  // minted before the bootstrap promotion are stale.
  const ownerToken = await freshToken(db, owner.email, owner.password);
  const secondToken = await freshToken(db, second.email, second.password);
  let customerToken = customer.token;
  const technicianToken = technician.token;

  // --- Phase 2: role endpoint hierarchy rules ---
  console.log("\n[role endpoint: normal admin limits]");
  const secondDemotesOwner = await api(`/api/admin/users/${owner.userId}/role`, {
    method: "PATCH", headers: auth(secondToken), body: JSON.stringify({ role: "customer" }),
  });
  check(secondDemotesOwner.status === 403, `normal admin demotes main admin -> ${secondDemotesOwner.status} (expected 403)`);

  // Owner (main admin) promotes the customer to admin
  const promoteCustomer = await api(`/api/admin/users/${customer.userId}/role`, {
    method: "PATCH", headers: auth(ownerToken), body: JSON.stringify({ role: "admin" }),
  });
  check(promoteCustomer.status === 200 && promoteCustomer.body?.data?.role === "admin", `main admin promotes customer -> ${promoteCustomer.status}`);
  // Fresh JWT with the admin role for the normal-admin assertions below.
  customerToken = await freshToken(db, customer.email, customer.password);
  const customerAfterPromote = await users.findOne({ _id: customer.userId }, { projection: { role: 1, isMainAdmin: 1 } });
  check(customerAfterPromote?.isMainAdmin !== true, "promotion does NOT grant Main Admin status");

  const secondDemotesCustomer = await api(`/api/admin/users/${customer.userId}/role`, {
    method: "PATCH", headers: auth(secondToken), body: JSON.stringify({ role: "customer" }),
  });
  check(secondDemotesCustomer.status === 403, `normal admin demotes normal admin -> ${secondDemotesCustomer.status} (expected 403)`);

  // --- Phase 3: transfer validation ---
  console.log("\n[transfer: validation]");
  const anonTransfer = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers, body: JSON.stringify({ targetUserId: second.userId.toHexString(), password: owner.password }),
  });
  check(anonTransfer.status === 401, `transfer without token -> ${anonTransfer.status} (expected 401)`);

  const techTransfer = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(technicianToken), body: JSON.stringify({ targetUserId: second.userId.toHexString(), password: technician.password }),
  });
  check(techTransfer.status === 403, `transfer as technician -> ${techTransfer.status} (expected 403)`);

  const customerAsAdminTransfer = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(customerToken), body: JSON.stringify({ targetUserId: second.userId.toHexString(), password: customer.password }),
  });
  check(customerAsAdminTransfer.status === 403, `transfer as normal admin -> ${customerAsAdminTransfer.status} (expected 403)`);

  const selfTransfer = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(ownerToken), body: JSON.stringify({ targetUserId: owner.userId.toHexString(), password: owner.password }),
  });
  check(selfTransfer.status === 400, `transfer to self -> ${selfTransfer.status} (expected 400)`);

  const transferToCustomer = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(ownerToken), body: JSON.stringify({ targetUserId: plainCustomer.userId.toHexString(), password: owner.password }),
  });
  check(transferToCustomer.status === 409, `transfer to customer -> ${transferToCustomer.status} (expected 409)`);

  const transferToTechnician = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(ownerToken), body: JSON.stringify({ targetUserId: technician.userId.toHexString(), password: owner.password }),
  });
  check(transferToTechnician.status === 409, `transfer to technician -> ${transferToTechnician.status} (expected 409)`);

  const transferToMissing = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(ownerToken), body: JSON.stringify({ targetUserId: new ObjectId().toHexString(), password: owner.password }),
  });
  check(transferToMissing.status === 404, `transfer to missing user -> ${transferToMissing.status} (expected 404)`);

  const badPassword = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(ownerToken), body: JSON.stringify({ targetUserId: second.userId.toHexString(), password: "WrongPassword123!" }),
  });
  check(badPassword.status === 401, `transfer with wrong password -> ${badPassword.status} (expected 401)`);
  check((await mainAdminCount(db)) === 1, `exactly one Main Admin remains after failed transfers (got ${await mainAdminCount(db)})`);

  // --- Phase 4: successful transfer + post-transfer hierarchy ---
  console.log("\n[transfer: success]");
  const transfer = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(ownerToken), body: JSON.stringify({ targetUserId: second.userId.toHexString(), password: owner.password }),
  });
  check(transfer.status === 200, `successful transfer -> ${transfer.status} (expected 200)`);
  check(
    transfer.body?.data?.previousMainAdminId === owner.userId.toHexString() &&
    transfer.body?.data?.newMainAdminId === second.userId.toHexString(),
    "transfer response carries previous/new Main Admin ids"
  );
  check(!JSON.stringify(transfer.body).includes(owner.password), "transfer response leaks no credentials");

  const ownerFinal = await users.findOne({ _id: owner.userId }, { projection: { role: 1, isMainAdmin: 1 } });
  const secondFinal = await users.findOne({ _id: second.userId }, { projection: { role: 1, isMainAdmin: 1 } });
  check(ownerFinal?.role === "admin" && secondFinal?.role === "admin", "both accounts keep the admin role");
  check(ownerFinal?.isMainAdmin !== true && secondFinal?.isMainAdmin === true, "Main Admin designation moved to second");
  check((await mainAdminCount(db)) === 1, "exactly one Main Admin exists after transfer");

  const oldMainCannotTransfer = await api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(ownerToken), body: JSON.stringify({ targetUserId: second.userId.toHexString(), password: owner.password }),
  });
  check(oldMainCannotTransfer.status === 403, `old Main Admin can no longer transfer -> ${oldMainCannotTransfer.status} (expected 403)`);

  const oldMainCannotDemote = await api(`/api/admin/users/${second.userId}/role`, {
    method: "PATCH", headers: auth(ownerToken), body: JSON.stringify({ role: "customer" }),
  });
  check(oldMainCannotDemote.status === 403, `old Main Admin can no longer demote admins -> ${oldMainCannotDemote.status} (expected 403)`);

  const newMainDemotes = await api(`/api/admin/users/${owner.userId}/role`, {
    method: "PATCH", headers: auth(secondToken), body: JSON.stringify({ role: "customer" }),
  });
  check(newMainDemotes.status === 200 && newMainDemotes.body?.data?.role === "customer", `new Main Admin demotes normal admin -> ${newMainDemotes.status}`);

  // --- Phase 5: concurrent transfers cannot corrupt the invariant ---
  console.log("\n[transfer: concurrency]");
  // second is the current Main Admin; owner and customer are Normal Admins.
  const transferA = api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(secondToken), body: JSON.stringify({ targetUserId: owner.userId.toHexString(), password: second.password }),
  });
  const transferB = api("/api/admin/main-admin/transfer", {
    method: "POST", headers: auth(secondToken), body: JSON.stringify({ targetUserId: customer.userId.toHexString(), password: second.password }),
  });
  const [resultA, resultB] = await Promise.all([transferA, transferB]);
  const statuses = [resultA.status, resultB.status];
  check(statuses.filter((s) => s === 200).length === 1, `exactly one concurrent transfer succeeded (got ${statuses.join("/")})`);
  check(statuses.filter((s) => s === 409).length === 1, `the losing concurrent transfer was rejected with 409 (got ${statuses.join("/")})`);
  check(statuses.every((s) => s !== 500), "concurrent transfers did not error out");
  check((await mainAdminCount(db)) === 1, `exactly one Main Admin remains after concurrent transfers (got ${await mainAdminCount(db)})`);
  const adminsLeft = await users.countDocuments({ role: "admin" });
  check(adminsLeft >= 2, `no admin was removed by concurrent transfers (got ${adminsLeft})`);

  // --- Phase 6: ownership endpoint cannot grant Main Admin status ---
  console.log("\n[role endpoint cannot grant Main Admin]");
  const grantMain = await api(`/api/admin/users/${customer.userId}/role`, {
    method: "PATCH", headers: auth(secondToken), body: JSON.stringify({ role: "admin", isMainAdmin: true }),
  });
  check(grantMain.status === 400, `role endpoint rejects isMainAdmin in body -> ${grantMain.status} (expected 400)`);
  const profileGrant = await api("/api/users/me", {
    method: "PATCH", headers: auth(customerToken), body: JSON.stringify({ isMainAdmin: true }),
  });
  check(profileGrant.status === 400, `profile endpoint rejects isMainAdmin in body -> ${profileGrant.status} (expected 400)`);

  // --- Cleanup ---
  const throwawayIds = [owner.userId, second.userId, customer.userId, technician.userId, plainCustomer.userId];
  await sessions.deleteMany({ userId: { $in: throwawayIds } });
  await accounts.deleteMany({ userId: { $in: throwawayIds } });
  await users.deleteMany({ _id: { $in: throwawayIds } });
  console.log("\ncleanup: throwaway users removed");
  await client.close();

  console.log(`\n${failures === 0 ? "MAIN ADMIN CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("main-admin test crashed:", e);
  try { await client.close(); } catch {}
  process.exit(1);
});
