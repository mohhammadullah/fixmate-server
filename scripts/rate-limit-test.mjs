/**
 * FixMate rate-limit integration test.
 *
 * Verifies the corrected auth rate-limit behavior introduced in
 * src/config/auth.ts / src/config/env.ts / src/app.ts.
 *
 * Root cause being guarded against: Better Auth used to run with implicit
 * defaults — production-only, 3 requests per 10s on credential paths, and
 * one shared bucket for ALL users when the client IP could not be resolved
 * (no trusted proxy configured). The Express authLimiter on top of it
 * double-counted every auth request.
 *
 * Non-production (default):
 *   - Repeated bad-password sign-in attempts are NOT throttled at the tiny
 *     production threshold (development budgets are generous by design).
 *   - /api/health stays reachable.
 *
 * Production (--prod through with-isolated-app.mjs):
 *   - 10 bad-password sign-in attempts from one client IP are answered
 *     (401), the 11th inside the window is rejected with 429.
 *   - A DIFFERENT client IP is not locked out by the first IP's bucket
 *     (per-IP keys, no global lockout).
 *   - /api/health stays reachable.
 *
 * No users are created and nothing is written to the database; the test
 * only fires sign-in attempts with a nonexistent account.
 * Usage:
 *   node scripts/with-isolated-app.mjs scripts/rate-limit-test.mjs
 *   node scripts/with-isolated-app.mjs scripts/rate-limit-test.mjs --prod
 */
import "dotenv/config";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const IS_PROD = process.env.NODE_ENV === "production";

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const signIn = async (ip) => {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      origin: process.env.TEST_ORIGIN ?? "http://localhost:3000",
      // Single-value X-Forwarded-For is what Better Auth trusts by default
      // (see src/config/auth.ts). Distinct documentation-block IPs keep
      // each check isolated from every other suite.
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({
      email: `fixmate.ratelimit.${Date.now()}@example.com`,
      password: "WrongPassword123!",
    }),
  });
  await res.text();
  return res.status;
};

const health = async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  return res.status;
};

const main = async () => {
  console.log(`Rate-limit test against ${BASE_URL} (NODE_ENV=${process.env.NODE_ENV ?? "unspecified"})\n`);

  if (IS_PROD) {
    console.log("[production: credential paths throttle after 10 attempts/minute per IP]");
    const ip = "198.51.100.201";
    let first429 = null;
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const status = await signIn(ip);
      if (status === 429) { first429 = attempt; break; }
      if (status !== 401) fail(`attempt ${attempt} -> ${status} (expected 401)`);
    }
    check(first429 === 11, `11th sign-in attempt within a minute -> 429 (first 429 at attempt ${first429})`);

    console.log("\n[production: a different client IP is not locked out by the first IP's bucket]");
    const other = await signIn("198.51.100.202");
    check(other === 401, `sign-in from a fresh IP -> ${other} (expected 401, not 429)`);

    console.log("\n[production: /api/health remains reachable]");
    check((await health()) === 200, "/api/health -> 200");
  } else {
    console.log("[development: generous budgets, no premature throttling]");
    const ip = "198.51.100.101";
    let throttled = false;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const status = await signIn(ip);
      if (status === 429) throttled = true;
      else check(status === 401, `attempt ${attempt} -> ${status} (expected 401)`);
    }
    check(!throttled, "5 bad-password attempts were not throttled in development");

    console.log("\n[development: /api/health remains reachable]");
    check((await health()) === 200, "/api/health -> 200");
  }

  console.log(`\n${failures === 0 ? "RATE-LIMIT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("rate-limit test crashed:", error);
  process.exit(1);
});
