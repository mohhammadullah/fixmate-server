/**
 * FixMate isolated-app test runner (development only).
 *
 * The :5000 development server shares one 100-request/15-minute auth rate
 * limit per client; running the whole integration chain against it can
 * exhaust the budget and fail suites with HTTP 429 — not a defect, just a
 * shared window. This runner sidesteps it by booting its OWN copy of the API
 * on an ephemeral port with a fresh auth-limit window, backed by the same
 * real development MongoDB database. Each run executes exactly one ordinary
 * BASE_URL-pointed suite — the suite itself needs no changes.
 *
 * Usage: node scripts/with-isolated-app.mjs <suite.mjs> [--prod]
 *   e.g. node scripts/with-isolated-app.mjs scripts/booking-details-test.mjs
 *        node scripts/with-isolated-app.mjs scripts/auth-hardening-test.mjs --prod
 *
 * --prod boots the API with NODE_ENV=production so production-only behavior
 * (e.g. /api/test/* returning 404) can be verified. Development tests omit it.
 *
 * Requires `npm run build` first (the runner imports ../dist).
 *
 * Nothing here touches the running development server or .env.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(REPO_ROOT);

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const main = async () => {
  const argv = process.argv.slice(2);
  const prod = argv.includes("--prod");
  const suite = argv.find((arg) => arg !== "--prod");

  if (!suite || argv.filter((arg) => arg !== "--prod").length !== 1) {
    console.error("usage: node scripts/with-isolated-app.mjs <suite.mjs> [--prod]");
    process.exit(1);
  }

  const port = await getFreePort();

  // Pre-set test-only env BEFORE any dist import. dotenv does not override
  // variables that are already set.
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${port}`;
  if (prod) {
    process.env.NODE_ENV = "production";
  }
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_mock_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_mock_test_secret_0123456789";
  process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";

  const { connectDB, closeDB } = await import("../dist/config/db.js");
  const { ensureIndexes } = await import("../dist/config/indexes.js");
  const { createAuth } = await import("../dist/config/auth.js");
  const { createApp } = await import("../dist/app.js");

  await connectDB();
  await ensureIndexes();

  const app = createApp(createAuth());
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  try {
    const code = await new Promise((resolve) => {
      // tsx handles plain .mjs suites and suites that dynamically import the
      // TypeScript sources alike.
      const child = spawn(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["tsx", path.resolve(REPO_DIR, suite)],
        {
          env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
          stdio: "inherit",
          shell: true,
        }
      );
      child.on("exit", (c) => resolve(c ?? 1));
      child.on("error", () => resolve(1));
    });

    process.exitCode = code;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeDB();
  }
};

main().catch((error) => {
  console.error("isolated runner crashed:", error);
  process.exit(1);
});
