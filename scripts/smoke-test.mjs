/**
 * FixMate auth/API smoke test.
 *
 * Runs against a locally running server (default http://localhost:5000).
 * Creates or reuses a clearly identified development test account
 * (fixmate.test@example.com by default). Credentials are read from
 * TEST_USER_EMAIL / TEST_USER_PASSWORD env vars; if no password is given,
 * a random one is generated (fine for a fresh account, unusable for an
 * existing one — in that case export the password you signed up with).
 *
 * Usage: node scripts/smoke-test.mjs
 */
import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL ?? "fixmate.test@example.com";
const TEST_PASSWORD =
  process.env.TEST_USER_PASSWORD ?? crypto.randomUUID() + "Aa1!";
const TEST_NAME = "FixMate Smoke Test";

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

// Browsers always send Origin on state-changing requests; Better Auth's
// CSRF middleware rejects non-GET requests without it (403 MISSING_OR_NULL_ORIGIN).
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

const main = async () => {
  console.log(`Smoke test against ${BASE_URL}`);
  console.log(`Test account: ${TEST_EMAIL}\n`);

  // --- Health endpoints ---
  console.log("[health]");
  const health = await api("/api/health");
  check(health.status === 200 && health.body?.success === true, "GET /api/health -> 200");
  const root = await api("/");
  check(root.status === 200 && root.body?.success === true, "GET / -> 200");
  const notFound = await api("/does-not-exist");
  check(notFound.status === 404, "GET /does-not-exist -> 404");

  // --- Public routes ---
  console.log("\n[public routes]");
  const pub = await api("/api/test/public");
  check(pub.status === 200 && pub.body?.success === true, "GET /api/test/public -> 200 without token");

  // --- Better Auth signup ---
  console.log("\n[signup]");
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME }),
  });
  const alreadyExists =
    signup.status >= 400 &&
    JSON.stringify(signup.body ?? "").toLowerCase().includes("exist");
  if (signup.status === 200 || signup.status === 201) {
    pass("signup -> created test account");
  } else if (alreadyExists) {
    console.log("  INFO  test account already exists, will sign in instead");
  } else {
    fail(`signup -> unexpected status ${signup.status}: ${JSON.stringify(signup.body)}`);
  }

  // --- Better Auth signin ---
  console.log("\n[signin]");
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  check(signin.status === 200, `signin -> ${signin.status} (expected 200)`);
  const setCookie = signin.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.includes("session_token"))?.split(";")[0];
  check(typeof sessionCookie === "string", "signin set a session cookie");
  if (alreadyExists && signin.status !== 200) {
    console.error("\nSign-in for the existing test account failed. Re-run with TEST_USER_PASSWORD set to the password used at first signup.");
    process.exit(1);
  }

  // --- Role must NOT be user-editable at signup (role field is input:false) ---
  console.log("\n[signup role hardening]");
  const signupRoleAttempt = await api("/api/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      email: "fixmate.rolecheck@example.com",
      password: TEST_PASSWORD,
      name: TEST_NAME,
      role: "admin",
    }),
  });
  if (signupRoleAttempt.status === 200 || signupRoleAttempt.status === 201) {
    const role = signupRoleAttempt.body?.user?.role;
    check(role === "customer", `role injection ignored at signup (role=${role})`);
  } else if (
    signupRoleAttempt.status >= 400 &&
    JSON.stringify(signupRoleAttempt.body ?? "").toLowerCase().includes("exist")
  ) {
    console.log("  INFO  fixmate.rolecheck@example.com already exists; role-injection assertion covered by first run");
  } else {
    console.log(`  INFO  role-check signup returned ${signupRoleAttempt.status}; skipping assertion`);
  }

  // --- JWT token endpoint ---
  console.log("\n[jwt]");
  const tokenRes = await api("/api/auth/token", {
    headers: sessionCookie ? { cookie: sessionCookie } : {},
  });
  check(tokenRes.status === 200 && typeof tokenRes.body?.token === "string", "GET /api/auth/token -> 200 with session");
  const token = tokenRes.body?.token;

  if (token) {
    const payload = decodeJwt(token);
    console.log(`  INFO  iss=${payload.iss} aud=${payload.aud} exp=${payload.exp ? new Date(payload.exp * 1000).toISOString() : "n/a"} id=${payload.id ?? "(sub only)"} sub=${payload.sub} role=${payload.role}`);
    check(typeof payload.sub === "string" && payload.sub.length > 0, "token has sub");
    check(payload.id === payload.sub, "payload.id === payload.sub");
    check(typeof payload.email === "string", "payload has email");
    check(typeof payload.role === "string", "payload has role");

    // Verify signature/issuer/audience against the real JWKS endpoint
    try {
      const JWKS = createRemoteJWKSet(new URL(`${BASE_URL}/api/auth/jwks`));
      const { payload: verified } = await jwtVerify(token, JWKS, {
        issuer: payload.iss,
        audience: payload.aud,
      });
      pass(`jose verified signature/iss/aud (sub=${verified.sub})`);
    } catch (e) {
      fail(`jose verification failed: ${e.message}`);
    }

    // --- Protected routes with Bearer token ---
    console.log("\n[protected routes]");
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const protectedRes = await api("/api/test/protected", auth);
    check(protectedRes.status === 200, "GET /api/test/protected -> 200 with valid JWT");
    const customerRes = await api("/api/test/customer", auth);
    const roleNow = protectedRes.body?.user?.role;
    if (roleNow === "customer") {
      check(customerRes.status === 200, "GET /api/test/customer -> 200 for customer role");
      const techRes = await api("/api/test/technician", auth);
      check(techRes.status === 403, "GET /api/test/technician -> 403 for customer role");
      const adminRes = await api("/api/test/admin", auth);
      check(adminRes.status === 403, "GET /api/test/admin -> 403 for customer role");
    } else {
      console.log(`  INFO  test account role is '${roleNow}' (not customer) — role-specific assertions skipped`);
    }
  }

  // --- Negative auth cases ---
  console.log("\n[negative cases]");
  const missing = await api("/api/test/protected");
  check(missing.status === 401, "GET /api/test/protected without token -> 401");
  const malformed = await api("/api/test/protected", {
    headers: { authorization: "Bearer not.a.jwt" },
  });
  check(malformed.status === 401, "GET /api/test/protected with malformed token -> 401");
  const wrongScheme = await api("/api/test/protected", {
    headers: { authorization: "Basic abc123" },
  });
  check(wrongScheme.status === 401, "GET /api/test/protected with non-Bearer scheme -> 401");
  const garbage = await api("/api/test/protected", {
    headers: { authorization: "Bearer aaa.bbb.ccc.ddd.eee" },
  });
  check(garbage.status === 401, "GET /api/test/protected with garbage segments -> 401");

  // --- JWKS endpoint ---
  console.log("\n[jwks]");
  const jwks = await api("/api/auth/jwks");
  check(jwks.status === 200 && Array.isArray(jwks.body?.keys) && jwks.body.keys.length > 0, "GET /api/auth/jwks -> 200 with public keys");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
