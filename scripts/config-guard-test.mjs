/**
 * FixMate server startup/configuration guard test (no network, no database).
 *
 * Runs isolated child processes against dist/ so process.exit(1) on bad env
 * can be observed without touching a database. Covers: explicit NODE_ENV,
 * HTTPS/public URL validation, test-only override rejection, Stripe pairing,
 * and actionable index-startup failures (via an injected fake Db).
 *
 * Requires `npm run build` first.
 * Usage: node scripts/config-guard-test.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const ENV_SNIPPET =
  "import('./dist/config/env.js').then(m => console.log(JSON.stringify({" +
  "isProduction: m.env.isProduction, nodeEnv: m.env.NODE_ENV," +
  "paymentsConfigured: m.env.paymentsConfigured" +
  "}))).catch(e => { console.error(e.message); process.exit(1); })";

const baseEnv = () => {
  const env = { ...process.env };
  for (const key of [
    "NODE_ENV",
    "CLIENT_URL",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "MONGODB_URI",
    "MONGODB_DB_NAME",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_API_BASE",
    "IMGBB_UPLOAD_URL",
    "DOTENV_CONFIG_PATH",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    // Prevent dotenv/config from re-adding real values from the local .env;
    // these tests must control every configuration input explicitly.
    DOTENV_CONFIG_PATH: path.join(
      process.env.TEMP ?? "/tmp",
      "fixmate-config-guard-no-env"
    ),
    NODE_ENV: "production",
    CLIENT_URL: "https://app.example.invalid",
    BETTER_AUTH_URL: "https://api.example.invalid",
    BETTER_AUTH_SECRET: "configuration-test-secret-value-32-chars-min",
    MONGODB_URI: "mongodb://127.0.0.1:27017",
    MONGODB_DB_NAME: "config_guard_test",
  };
};

function loadEnv(overrides = {}) {
  const env = baseEnv();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, ["-e", ENV_SNIPPET], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
}

function envState(result) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

console.log("Server configuration guard test\n");

// --- NODE_ENV ---
console.log("\n[NODE_ENV]");
const noNodeEnv = loadEnv({ NODE_ENV: undefined });
check(
  noNodeEnv.status === 0 && envState(noNodeEnv)?.isProduction === false,
  "unset NODE_ENV does NOT enable production behavior"
);
const devEnv = loadEnv({ NODE_ENV: "development" });
check(
  devEnv.status === 0 && envState(devEnv)?.isProduction === false,
  "explicit development remains non-production"
);
const prodEnv = loadEnv();
check(
  prodEnv.status === 0 && envState(prodEnv)?.isProduction === true,
  "explicit NODE_ENV=production enables production behavior"
);
const httpClient = loadEnv({ CLIENT_URL: "http://app.example.invalid" });
check(
  httpClient.status !== 0 && httpClient.stderr.includes("CLIENT_URL must use HTTPS"),
  "production CLIENT_URL must be HTTPS"
);
const loopbackProd = loadEnv({
  CLIENT_URL: "http://127.0.0.1:3000",
  BETTER_AUTH_URL: "http://127.0.0.1:5000",
});
check(
  loopbackProd.status === 0 && envState(loopbackProd)?.isProduction === true,
  "loopback HTTP URLs remain available to isolated production-mode tests"
);
const httpAuth = loadEnv({ BETTER_AUTH_URL: "http://api.example.invalid" });
check(
  httpAuth.status !== 0 && httpAuth.stderr.includes("BETTER_AUTH_URL must use HTTPS"),
  "production BETTER_AUTH_URL must be HTTPS"
);
const missingClient = loadEnv({ CLIENT_URL: undefined, NODE_ENV: "production" });
check(
  missingClient.status !== 0 && missingClient.stderr.includes("CLIENT_URL"),
  "production CLIENT_URL cannot rely on the localhost default"
);

// --- test-only overrides ---
console.log("\n[test-only overrides]");
const stripeBase = loadEnv({ STRIPE_API_BASE: "http://127.0.0.1:4010" });
check(
  stripeBase.status !== 0 && stripeBase.stderr.includes("STRIPE_API_BASE"),
  "STRIPE_API_BASE is rejected in production"
);
const imgbbBase = loadEnv({ IMGBB_UPLOAD_URL: "http://127.0.0.1:4011/upload" });
check(
  imgbbBase.status !== 0 && imgbbBase.stderr.includes("IMGBB_UPLOAD_URL"),
  "IMGBB_UPLOAD_URL is rejected in production"
);
const devOverride = loadEnv({
  NODE_ENV: "development",
  STRIPE_API_BASE: "http://127.0.0.1:4010",
});
check(
  devOverride.status === 0,
  "test-only STRIPE_API_BASE override is still allowed in development"
);

// --- Stripe pairing ---
console.log("\n[Stripe pairing]");
const keyOnly = loadEnv({ STRIPE_SECRET_KEY: "sk_test_placeholder" });
check(
  keyOnly.status !== 0 && keyOnly.stderr.includes("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET"),
  "Stripe key without webhook secret fails startup"
);
const webhookOnly = loadEnv({ STRIPE_WEBHOOK_SECRET: "whsec_test_placeholder" });
check(
  webhookOnly.status !== 0 &&
    webhookOnly.stderr.includes("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET"),
  "webhook secret without Stripe key fails startup"
);
const neither = loadEnv();
check(
  neither.status === 0 && envState(neither)?.paymentsConfigured === false,
  "both Stripe values absent -> payments reported unavailable"
);
const both = loadEnv({
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_test_placeholder",
});
check(
  both.status === 0 && envState(both)?.paymentsConfigured === true,
  "both Stripe values configured -> payments available"
);

// --- index startup guarantee (fake Db, no MongoDB connection) ---
console.log("\n[MongoDB index startup]");
const INDEX_SNIPPET = `
(async () => {
  const mod = await import('./dist/config/indexes.js');
  const names = [...mod.CRITICAL_INDEX_NAMES];
  const goodDb = { collection: () => ({ createIndexes: async () => names }) };
  const created = await mod.ensureIndexes(goodDb);
  if (!names.every((n) => created.includes(n))) { console.error('missing created names'); process.exit(1); }
  const badDb = { collection: () => ({ createIndexes: async () => {
    throw new Error('E11000 duplicate key error collection: config_guard_test.bookings index: bookings_active_customer_service_unique dup key: { a: 1 }');
  } }) };
  try {
    await mod.ensureIndexes(badDb);
    console.error('ensureIndexes did not fail on a duplicate-key error');
    process.exit(1);
  } catch (error) {
    const ok = /config_guard_test\\.bookings/.test(error.message) &&
      /bookings_active_customer_service_unique/.test(error.message) &&
      /manually merge or remove/.test(error.message);
    if (!ok) { console.error(error.message); process.exit(1); }
    console.log('INDEX_GUARD_OK');
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
`;
const indexResult = spawnSync(process.execPath, ["-e", INDEX_SNIPPET], {
  cwd: ROOT,
  env: baseEnv(),
  encoding: "utf8",
});
check(
  indexResult.status === 0 && indexResult.stdout.includes("INDEX_GUARD_OK"),
  "duplicate legacy data fails index startup with an actionable error; no records are modified"
);

console.log(`\n${failures === 0 ? "CONFIG GUARD CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
