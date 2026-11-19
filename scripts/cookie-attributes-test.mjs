/**
 * Focused check for Better Auth cookie attributes across environments.
 *
 * Verifies the production cross-origin fix (SameSite=None + Secure) while
 * preserving local development defaults (SameSite=Lax). Uses Better Auth's
 * own cookie helper with the same option shape produced by src/config/auth.ts,
 * so it does not require a database or running server.
 *
 * Usage:
 *   node scripts/cookie-attributes-test.mjs
 */
import { getCookies } from "better-auth/cookies";

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const baseOptions = (isProduction) => ({
  baseURL: isProduction
    ? "https://fixmate-server-0mzf.onrender.com"
    : "http://localhost:5000",
  trustedOrigins: [
    isProduction
      ? "https://fixmate-client-neon.vercel.app"
      : "http://localhost:3000",
  ],
  ...(isProduction
    ? {
        advanced: {
          defaultCookieAttributes: {
            sameSite: "none",
            secure: true,
          },
        },
      }
    : {}),
});

const assertCookie = (label, cookies, expected) => {
  const attrs = cookies.sessionToken.attributes;
  check(attrs.sameSite === expected.sameSite, `${label}: session_token sameSite=${attrs.sameSite} (expected ${expected.sameSite})`);
  check(attrs.secure === expected.secure, `${label}: session_token secure=${attrs.secure} (expected ${expected.secure})`);
  check(attrs.httpOnly === true, `${label}: session_token httpOnly=true`);
  check(attrs.path === "/", `${label}: session_token path=/`);
  check(
    cookies.sessionToken.name === expected.name,
    `${label}: session_token name=${cookies.sessionToken.name} (expected ${expected.name})`
  );

  const dataAttrs = cookies.sessionData.attributes;
  check(dataAttrs.sameSite === expected.sameSite, `${label}: session_data sameSite=${dataAttrs.sameSite} (expected ${expected.sameSite})`);
  check(dataAttrs.secure === expected.secure, `${label}: session_data secure=${dataAttrs.secure} (expected ${expected.secure})`);
};

console.log("Cookie attribute checks\n");

console.log("[production: cross-origin frontend/backend]");
const prodCookies = getCookies(baseOptions(true));
assertCookie("production", prodCookies, {
  sameSite: "none",
  secure: true,
  name: "__Secure-better-auth.session_token",
});

console.log("\n[development: local defaults preserved]");
const devCookies = getCookies(baseOptions(false));
assertCookie("development", devCookies, {
  sameSite: "lax",
  secure: false,
  name: "better-auth.session_token",
});

console.log(`\n${failures === 0 ? "COOKIE ATTRIBUTE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
