/**
 * FixMate role-matrix test (development only).
 *
 * The public signup path intentionally always assigns role=customer. To
 * verify technician/admin authorization end-to-end we switch the clearly
 * identified development test account's role directly in MongoDB, fetch a
 * fresh JWT (role is embedded at issuance time) after each switch, and
 * exercise the role-gated endpoints. The account's role is restored to
 * "customer" when the script finishes.
 *
 * Also removes smoke-test artifacts: users matching
 * fixmate.rolecheck.<timestamp>@example.com.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env),
 *               TEST_USER_EMAIL, TEST_USER_PASSWORD.
 * Usage: node scripts/role-matrix-test.mjs
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL ?? "fixmate.test@example.com";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD;
const TEST_NAME = "FixMate Smoke Test";

if (!TEST_PASSWORD) {
  console.error("TEST_USER_PASSWORD is required (same value used for the smoke test).");
  process.exit(1);
}
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

const main = async () => {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");

  // --- Cleanup of smoke-test artifacts from earlier runs ---
  const artifactFilter = { email: { $regex: /^fixmate\.rolecheck\.[0-9]+@example\.com$/ } };
  const artifacts = await users.find(artifactFilter, { projection: { _id: 1 } }).toArray();
  if (artifacts.length > 0) {
    const ids = artifacts.map((u) => u._id);
    // Better Auth's MongoDB adapter stores userId as ObjectId in the
    // session/account collections (JSON.stringify only *shows* hex strings).
    const sessions = await db.collection("session").deleteMany({ userId: { $in: ids } });
    const accounts = await db.collection("account").deleteMany({ userId: { $in: ids } });
    const deleted = await users.deleteMany(artifactFilter);
    console.log(`cleanup: removed ${deleted.deletedCount} artifact user(s), ${sessions.deletedCount} session(s), ${accounts.deletedCount} account(s)`);
  } else {
    console.log("cleanup: no timestamped rolecheck artifacts found");
  }

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

  const testUser = await users.findOne({ email: TEST_EMAIL });
  if (!testUser) throw new Error(`test user ${TEST_EMAIL} not found`);
  const originalRole = testUser.role ?? "customer";
  console.log(`test account role before matrix: ${originalRole}\n`);

  const expectations = {
    customer: { customer: 200, technician: 403, admin: 403 },
    technician: { customer: 403, technician: 200, admin: 403 },
    admin: { customer: 403, technician: 403, admin: 200 },
  };

  try {
    for (const role of ["customer", "technician", "admin"]) {
      await users.updateOne({ email: TEST_EMAIL }, { $set: { role } });

      // Fresh JWT — role is embedded at issuance time.
      const tokenRes = await api("/api/auth/token", { headers: { cookie: sessionCookie } });
      if (tokenRes.status !== 200 || !tokenRes.body?.token) {
        fail(`${role}: could not obtain JWT (status ${tokenRes.status})`);
        continue;
      }
      const token = tokenRes.body.token;
      const auth = { headers: { authorization: `Bearer ${token}` } };

      console.log(`[role=${role}]`);
      for (const [route, expected] of Object.entries(expectations[role])) {
        const res = await api(`/api/test/${route}`, auth);
        const ok = res.status === expected;
        (ok ? pass : fail)(`GET /api/test/${route} -> ${res.status} (expected ${expected})`);
      }
      console.log();
    }
  } finally {
    // Restore the test account to its original role.
    await users.updateOne({ email: TEST_EMAIL }, { $set: { role: originalRole } });
    console.log(`test account role restored to '${originalRole}'`);
    await client.close();
  }

  console.log(`\n${failures === 0 ? "ROLE MATRIX PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("role-matrix test crashed:", e);
  try {
    await client.close();
  } catch {}
  process.exit(1);
});
