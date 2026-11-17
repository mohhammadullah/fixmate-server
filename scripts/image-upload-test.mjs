/**
 * FixMate image-upload endpoint test (development only). Run with tsx.
 *
 * Spins up a local mock ImgBB server and an in-process API app, then verifies
 * authentication, technician-only authorization, MIME/magic-byte validation,
 * size limits, missing files, safe response shape, and ImgBB failure handling.
 * A throwaway technician/customer from the running dev server provide real
 * JWTs; no real ImgBB key or network call is ever required.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME, BETTER_AUTH_* (from .env).
 * Optional env: BASE_URL (running dev server, default http://localhost:5000).
 * Usage: npx tsx scripts/image-upload-test.mjs
 */
import "dotenv/config";
import http from "node:http";
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

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

const main = async () => {
  console.log(`Image-upload test against ${BASE_URL} (mocked ImgBB)\n`);

  // --- Mock ImgBB ---
  let mode = "success";
  mock: {
    const mock = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.searchParams.get("key") !== "test-key") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: { message: "bad key" } }));
        return;
      }
      if (mode === "invalid-json") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("not json");
        return;
      }
      if (mode === "error") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: { message: "upload rejected" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: { url: "https://i.imgbb.com/seeded-image.png", display_url: "https://i.imgbb.com/seeded-image.png" },
      }));
    });
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const address = mock.address();
    const mockPort = typeof address === "object" && address ? address.port : 0;
    process.env.IMGBB_API_KEY = "test-key";
    process.env.IMGBB_UPLOAD_URL = `http://127.0.0.1:${mockPort}`;

    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const db = client.db(process.env.MONGODB_DB_NAME);
    const users = db.collection("user");

    const makeUser = async (label, role) => {
      const email = `fixmate.upload.${label}.${Date.now()}@example.com`;
      const password = crypto.randomUUID() + "Aa1!";
      const signup = await api("/api/auth/sign-up/email", {
        method: "POST", headers,
        body: JSON.stringify({ email, password, name: `Upload ${label}` }),
      });
      if (signup.status !== 200 && signup.status !== 201) throw new Error(`signup ${label}: ${signup.status}`);
      if (role !== "customer") await users.updateOne({ email }, { $set: { role } });
      const signin = await api("/api/auth/sign-in/email", {
        method: "POST", headers, body: JSON.stringify({ email, password }),
      });
      if (signin.status !== 200) throw new Error(`signin ${label}: ${signin.status}`);
      const cookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
      const tokenRes = await api("/api/auth/token", { headers: { cookie } });
      if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") throw new Error(`token ${label}: ${tokenRes.status}`);
      const user = await users.findOne({ email });
      return { userId: user._id, token: tokenRes.body.token };
    };

    const tech = await makeUser("tech", "technician");
    const customer = await makeUser("customer", "customer");
    console.log("throwaway users created\n");

    // In-process app with the mock ImgBB endpoint configured.
    const { connectDB, closeDB } = await import("../src/config/db.ts");
    const { createAuth } = await import("../src/config/auth.ts");
    const { createApp } = await import("../src/app.ts");
    await connectDB();
    const app = createApp(createAuth());
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = server.address().port;
    const endpoint = `http://127.0.0.1:${port}/api/uploads/image`;

    const call = async (token, form) => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: res.status, body };
    };
    const formWith = (blob, name) => {
      const form = new FormData();
      if (blob) form.append("image", blob, name);
      return form;
    };
    const pngBlob = new Blob([PNG], { type: "image/png" });

    try {
      // --- Auth ---
      console.log("[authorization]");
      const anon = await call(null, formWith(pngBlob, "a.png"));
      check(anon.status === 401, `no token -> ${anon.status} (expected 401)`);
      const nonTech = await call(customer.token, formWith(pngBlob, "a.png"));
      check(nonTech.status === 403, `customer -> ${nonTech.status} (expected 403)`);

      // --- Input validation ---
      console.log("\n[validation]");
      const missing = await call(tech.token, formWith(null));
      check(missing.status === 400 && missing.body?.success === false, `missing file -> ${missing.status} (expected 400)`);
      const badMime = await call(tech.token, formWith(new Blob([PNG], { type: "text/plain" }), "a.txt"));
      check(badMime.status === 400, `text/plain -> ${badMime.status} (expected 400)`);
      const gif = await call(tech.token, formWith(new Blob([PNG], { type: "image/gif" }), "a.gif"));
      check(gif.status === 400, `image/gif -> ${gif.status} (expected 400)`);
      const spoofed = await call(tech.token, formWith(new Blob([new TextEncoder().encode("not an image")], { type: "image/png" }), "a.png"));
      check(spoofed.status === 400, `spoofed PNG bytes -> ${spoofed.status} (expected 400)`);
      const oversizedBytes = new Uint8Array(PNG.length + 5 * 1024 * 1024);
      oversizedBytes.set(PNG);
      const oversized = await call(tech.token, formWith(new Blob([oversizedBytes], { type: "image/png" }), "big.png"));
      check(oversized.status === 400, `>5MB file -> ${oversized.status} (expected 400)`);

      // --- Success shape ---
      console.log("\n[success]");
      mode = "success";
      const ok = await call(tech.token, formWith(pngBlob, "service.png"));
      check(ok.status === 200 && ok.body?.success === true, `valid PNG -> ${ok.status} (expected 200)`);
      check(ok.body?.data?.url === "https://i.imgbb.com/seeded-image.png", "returned mocked image URL");
      check(ok.body?.data?.mime === "image/png" && ok.body?.data?.size === PNG.length, "safe mime/size metadata present");
      const keys = Object.keys(ok.body?.data ?? {});
      check(!keys.some((k) => /key|token|secret/i.test(k)), `no credentials in response (keys: ${keys.join(", ")})`);

      // --- ImgBB failures ---
      console.log("\n[upstream failures]");
      mode = "error";
      const upstreamError = await call(tech.token, formWith(pngBlob, "service.png"));
      check(upstreamError.status === 502 && upstreamError.body?.success === false, `ImgBB error -> ${upstreamError.status} (expected 502)`);
      check(!JSON.stringify(upstreamError.body).includes("upload rejected"), "upstream error details not leaked");
      mode = "invalid-json";
      const invalidJson = await call(tech.token, formWith(pngBlob, "service.png"));
      check(invalidJson.status === 502, `invalid ImgBB JSON -> ${invalidJson.status} (expected 502)`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await closeDB();
      await users.deleteMany({ _id: { $in: [tech.userId, customer.userId] } });
      await db.collection("session").deleteMany({ userId: { $in: [tech.userId.toHexString(), customer.userId.toHexString()] } });
      await db.collection("account").deleteMany({ userId: { $in: [tech.userId.toHexString(), customer.userId.toHexString()] } });
      await client.close();
      console.log("\ncleanup: throwaway users removed, mock servers closed");
    }
    break mock;
  }
  console.log(`\n${failures === 0 ? "IMAGE-UPLOAD CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error("image-upload test crashed:", e);
  process.exit(1);
});
