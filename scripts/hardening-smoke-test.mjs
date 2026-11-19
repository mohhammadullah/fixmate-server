/**
 * Focused hardening smoke checks (isolated app).
 *
 * Covers: liveness/readiness health endpoints, Stripe webhook middleware
 * guards (signature/raw body handling), and strict ObjectId validation.
 *
 * Usage: node scripts/with-isolated-app.mjs scripts/hardening-smoke-test.mjs
 */
import "dotenv/config";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

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
  console.log(`Hardening smoke test against ${BASE_URL}\n`);

  console.log("[health endpoints]");
  const health = await api("/api/health");
  check(
    health.status === 200 &&
      health.body?.success === true &&
      health.body?.status === "ok" &&
      typeof health.body?.timestamp === "string",
    `/api/health lightweight liveness -> ${health.status} ${JSON.stringify(health.body)}`
  );
  const ready = await api("/api/ready");
  check(
    (ready.status === 200 || ready.status === 503) &&
      ready.body?.success === (ready.status === 200) &&
      (ready.body?.status === "ready" || ready.body?.status === "not_ready") &&
      typeof ready.body?.timestamp === "string" &&
      !("error" in (ready.body ?? {})) &&
      !("stack" in (ready.body ?? {})),
    `/api/ready readiness shape without internals -> ${ready.status} ${JSON.stringify(ready.body)}`
  );

  console.log("\n[webhook middleware guards]");
  const noSig = await api("/api/payments/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check(
    noSig.status === 400 && noSig.body?.message === "Missing Stripe signature.",
    `webhook without signature rejected -> ${noSig.status} ${JSON.stringify(noSig.body)}`
  );
  const badSig = await api("/api/payments/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=deadbeef",
    },
    body: "{}",
  });
  check(
    badSig.status === 400 && badSig.body?.message === "Invalid webhook signature.",
    `webhook with invalid signature rejected -> ${badSig.status} ${JSON.stringify(badSig.body)}`
  );

  console.log("\n[strict ObjectId validation]");
  // 12-byte non-hex string must not be accepted as a valid ObjectId param.
  const twelveByte = "aaaaaaaaaaaa";
  const invalidService = await api(`/api/services/${twelveByte}`);
  check(
    invalidService.status === 400 || invalidService.status === 404,
    `12-byte service id rejected as invalid/not found without cast acceptance -> ${invalidService.status} ${JSON.stringify(invalidService.body)}`
  );
  const invalidBooking = await api(`/api/bookings/${twelveByte}`, {
    headers: { authorization: "Bearer not-a-jwt" },
  });
  check(
    invalidBooking.status === 400 || invalidBooking.status === 401,
    `12-byte booking id not accepted as valid ObjectId path -> ${invalidBooking.status}`
  );

  console.log(`\n${failures === 0 ? "HARDENING SMOKE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("hardening smoke test crashed:", error);
  process.exit(1);
});
