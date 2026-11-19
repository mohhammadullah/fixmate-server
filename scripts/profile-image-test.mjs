/**
 * FixMate profile-image endpoint test (development only). Run with tsx.
 *
 * Spins up a local mock ImgBB server and an in-process API app, then verifies
 * the per-user profile image feature end-to-end: every authenticated role can
 * upload/replace/remove their own image, one user can never modify another
 * user's image (even by smuggling ids/roles into the multipart body),
 * unauthenticated requests are rejected, invalid or oversized images are
 * refused, protected account fields cannot be changed through this route, and
 * the technician service-image upload still works after the shared refactor.
 *
 * Throwaway accounts (customer, technician, admin, Main Admin) are created
 * through the BASE_URL server and removed afterwards. No real ImgBB key or
 * network call is ever used — the in-process app talks only to the mock.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME, BETTER_AUTH_* (from .env).
 * Optional env: BASE_URL (running dev server, default http://localhost:5000),
 *               TEST_ORIGIN. Run everything else through
 *               scripts/with-isolated-app.mjs so no dev server is needed.
 * Usage: npx tsx scripts/profile-image-test.mjs
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
const auth = (token) => ({ ...headers, authorization: `Bearer ${token}` });

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

const main = async () => {
  console.log(`Profile-image test against ${BASE_URL} (mocked ImgBB)\n`);

  // --- Mock ImgBB: hands out a distinct URL per upload so tests can tell
  // one user's image from another's ---
  let mockUploads = 0;
  mock: {
    const mock = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.searchParams.get("key") !== "test-key") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: { message: "bad key" } }));
        return;
      }
      mockUploads += 1;
      const hosted = `https://i.imgbb.com/mock-profile-${mockUploads}.png`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { url: hosted, display_url: hosted } }));
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
      const email = `fixmate.pfp.${label}.${Date.now()}@example.com`;
      const password = crypto.randomUUID() + "Aa1!";
      const signup = await api("/api/auth/sign-up/email", {
        method: "POST", headers,
        body: JSON.stringify({ email, password, name: `ProfileImage ${label}` }),
      });
      if (signup.status !== 200 && signup.status !== 201) throw new Error(`signup ${label}: ${signup.status}`);
      const promote = {};
      if (role === "technician" || role === "admin") promote.role = role;
      if (role === "mainadmin") {
        promote.role = "admin";
        promote.isMainAdmin = true;
      }
      if (Object.keys(promote).length > 0) await users.updateOne({ email }, { $set: promote });
      const signin = await api("/api/auth/sign-in/email", {
        method: "POST", headers, body: JSON.stringify({ email, password }),
      });
      if (signin.status !== 200) throw new Error(`signin ${label}: ${signin.status}`);
      const cookie = (signin.headers.getSetCookie?.() ?? []).find((c) => c.includes("session_token"))?.split(";")[0];
      const tokenRes = await api("/api/auth/token", { headers: { cookie } });
      if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") throw new Error(`token ${label}: ${tokenRes.status}`);
      const user = await users.findOne({ email });
      return { userId: user._id, token: tokenRes.body.token, email };
    };

    const accounts = {
      customer: await makeUser("customer", "customer"),
      technician: await makeUser("technician", "technician"),
      admin: await makeUser("admin", "admin"),
      mainadmin: await makeUser("mainadmin", "mainadmin"),
      bystander: await makeUser("bystander", "customer"),
    };
    console.log("throwaway users created: customer, technician, admin, mainadmin, bystander\n");

    // In-process app with the mock ImgBB endpoint configured.
    const { connectDB, closeDB } = await import("../src/config/db.ts");
    const { createAuth } = await import("../src/config/auth.ts");
    const { createApp } = await import("../src/app.ts");
    await connectDB();
    const app = createApp(createAuth());
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = server.address().port;
    const imageEndpoint = `http://127.0.0.1:${port}/api/users/me/image`;
    const serviceUploadEndpoint = `http://127.0.0.1:${port}/api/uploads/image`;

    const postImage = async (token, form) => {
      const res = await fetch(imageEndpoint, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: res.status, body };
    };
    const deleteImage = async (token) => {
      const res = await fetch(imageEndpoint, {
        method: "DELETE",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: res.status, body };
    };
    const pngBlob = () => new Blob([PNG], { type: "image/png" });
    const formWith = (blob, name = "avatar.png", extraFields = {}) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(extraFields)) form.append(key, String(value));
      if (blob) form.append("image", blob, name);
      return form;
    };
    const dbImage = async (userId) => {
      const doc = await users.findOne({ _id: userId }, { projection: { image: 1 } });
      return typeof doc?.image === "string" && doc.image.length > 0 ? doc.image : null;
    };

    try {
      // --- Authentication ---
      console.log("[authentication]");
      const anonPost = await postImage(null, formWith(pngBlob()));
      check(anonPost.status === 401, `unauthenticated POST /me/image -> ${anonPost.status} (expected 401)`);
      const anonDelete = await deleteImage(null);
      check(anonDelete.status === 401, `unauthenticated DELETE /me/image -> ${anonDelete.status} (expected 401)`);

      // --- Every role can upload its own image; ownership stays per-user ---
      console.log("\n[all roles upload their own image]");
      for (const [label, account, expectedRole] of [
        ["customer", accounts.customer, "customer"],
        ["technician", accounts.technician, "technician"],
        ["admin", accounts.admin, "admin"],
        ["main admin", accounts.mainadmin, "admin"],
      ]) {
        const res = await postImage(account.token, formWith(pngBlob()));
        const dto = res.body?.data ?? {};
        const stored = await dbImage(account.userId);
        check(res.status === 200 && res.body?.success === true, `${label} upload -> ${res.status} (expected 200)`);
        check(typeof dto.image === "string" && /^https:\/\/i\.imgbb\.com\//.test(dto.image), `${label} DTO carries the hosted image URL`);
        check(stored === dto.image, `${label} image persisted on own user document`);
        check(dto.role === expectedRole, `${label} role reported correctly in DTO`);
        const leaked = ["password", "passwordHash", "session", "account", "_id", "isMainAdmin", "reviewedBy", "rejectionReason"]
          .filter((key) => key in dto);
        check(leaked.length === 0, `${label} DTO excludes sensitive fields (found: ${leaked.join(", ") || "none"})`);
      }

      // --- Cross-user isolation, including smuggled identity fields ---
      console.log("\n[user isolation]");
      const customerUrlBefore = await dbImage(accounts.customer.userId);
      const sneaky = await postImage(
        accounts.technician.token,
        formWith(pngBlob(), "technician.png", {
          userId: accounts.customer.userId.toHexString(),
          id: accounts.customer.userId.toHexString(),
          role: "admin",
          email: "attacker@example.com",
          isMainAdmin: "true",
        })
      );
      check(sneaky.status === 200, `upload with smuggled fields -> ${sneaky.status} (expected 200, fields ignored)`);
      const customerUrlAfter = await dbImage(accounts.customer.userId);
      check(customerUrlAfter === customerUrlBefore, "another user's image URL is unchanged");
      const technicianDoc = await users.findOne({ _id: accounts.technician.userId });
      check(technicianDoc?.role === "technician", "smuggled role field did not change technician's role");
      check(technicianDoc?.email === accounts.technician.email, "smuggled email field did not change technician's email");
      check(technicianDoc?.isMainAdmin !== true, "smuggled isMainAdmin flag was not applied");
      const mainAdminDoc = await users.findOne({ _id: accounts.mainadmin.userId });
      check(mainAdminDoc?.isMainAdmin === true, "main admin flag intact after unrelated upload");

      // An attacker cannot aim the endpoint at another account via query params.
      const queryRes = await fetch(`${imageEndpoint}?userId=${accounts.customer.userId.toHexString()}`, {
        method: "POST",
        headers: { authorization: `Bearer ${accounts.technician.token}` },
        body: formWith(pngBlob()),
      });
      const customerUrlAfterQuery = await dbImage(accounts.customer.userId);
      check(queryRes.status === 200 && customerUrlAfterQuery === customerUrlBefore, "userId query parameter cannot retarget the endpoint");

      // --- GET /me reflects the stored image ---
      console.log("\n[profile DTO reflects image]");
      const meRes = await api("/api/users/me", { headers: auth(accounts.admin.token) });
      const adminImage = await dbImage(accounts.admin.userId);
      check(meRes.status === 200 && meRes.body?.data?.image === adminImage, "GET /api/users/me returns the stored image URL");

      // --- Validation ---
      console.log("\n[validation]");
      const missing = await postImage(accounts.customer.token, new FormData());
      check(missing.status === 400, `missing file -> ${missing.status} (expected 400)`);
      const gifFile = new FormData();
      gifFile.append("image", new Blob([PNG], { type: "image/gif" }), "a.gif");
      const gifRes = await postImage(accounts.customer.token, gifFile);
      check(gifRes.status === 400, `image/gif -> ${gifRes.status} (expected 400)`);
      const textFile = new FormData();
      textFile.append("image", new Blob([PNG], { type: "text/plain" }), "a.txt");
      const textRes = await postImage(accounts.customer.token, textFile);
      check(textRes.status === 400, `text/plain -> ${textRes.status} (expected 400)`);
      const spoofFile = new FormData();
      spoofFile.append("image", new Blob([new TextEncoder().encode("definitely not a png")], { type: "image/png" }), "a.png");
      const spoofRes = await postImage(accounts.customer.token, spoofFile);
      check(spoofRes.status === 400, `spoofed PNG bytes -> ${spoofRes.status} (expected 400)`);
      const oversizedBytes = new Uint8Array(PNG.length + 5 * 1024 * 1024);
      oversizedBytes.set(PNG);
      const bigFile = new FormData();
      bigFile.append("image", new Blob([oversizedBytes], { type: "image/png" }), "big.png");
      const bigRes = await postImage(accounts.customer.token, bigFile);
      check(bigRes.status === 400, `>5MB file -> ${bigRes.status} (expected 400)`);

      // image is not accepted through PATCH /me (strict schema).
      const patchImage = await api("/api/users/me", {
        method: "PATCH", headers: auth(accounts.customer.token),
        body: JSON.stringify({ image: "https://evil.example.com/avatar.png" }),
      });
      check(patchImage.status === 400, `image via PATCH /me -> ${patchImage.status} (expected 400)`);

      // --- Removal works and is idempotent ---
      console.log("\n[removal]");
      const removeRes = await deleteImage(accounts.admin.token);
      const afterRemove = await users.findOne({ _id: accounts.admin.userId }, { projection: { image: 1 } });
      check(removeRes.status === 200 && removeRes.body?.data?.image === null, `DELETE /me/image -> ${removeRes.status}, DTO image cleared`);
      check(afterRemove?.image === null, "image cleared on the user document");
      const removeAgain = await deleteImage(accounts.admin.token);
      check(removeAgain.status === 200, `second removal is idempotent -> ${removeAgain.status} (expected 200)`);

      // --- Replace: upload, re-upload, confirm the latest URL wins ---
      console.log("\n[replace]");
      const first = await postImage(accounts.bystander.token, formWith(pngBlob()));
      const second = await postImage(accounts.bystander.token, formWith(pngBlob()));
      const firstUrl = first.body?.data?.image;
      const secondUrl = second.body?.data?.image;
      const storedBystander = await dbImage(accounts.bystander.userId);
      check(first.status === 200 && second.status === 200 && firstUrl !== secondUrl, "re-upload succeeds and yields a new URL");
      check(storedBystander === secondUrl, "the latest upload replaces the previous image URL");

      // --- Service image upload (technician-only) still works ---
      console.log("\n[service image upload regression]");
      const techServiceForm = new FormData();
      techServiceForm.append("image", pngBlob(), "service.png");
      const techServiceRes = await fetch(serviceUploadEndpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${accounts.technician.token}` },
        body: techServiceForm,
      });
      const techServiceBody = await techServiceRes.json().catch(() => null);
      check(techServiceRes.status === 200 && techServiceBody?.success === true, `technician service upload -> ${techServiceRes.status} (expected 200)`);
      const customerServiceForm = new FormData();
      customerServiceForm.append("image", pngBlob(), "service.png");
      const customerServiceRes = await fetch(serviceUploadEndpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${accounts.customer.token}` },
        body: customerServiceForm,
      });
      check(customerServiceRes.status === 403, `customer service upload rejected -> ${customerServiceRes.status} (expected 403)`);
      const anonServiceRes = await fetch(serviceUploadEndpoint, { method: "POST", body: new FormData() });
      check(anonServiceRes.status === 401, `anonymous service upload rejected -> ${anonServiceRes.status} (expected 401)`);
    } finally {
      const ids = Object.values(accounts).map((account) => account.userId);
      await users.deleteMany({ _id: { $in: ids } });
      await db.collection("session").deleteMany({ userId: { $in: ids.map(String) } });
      await db.collection("account").deleteMany({ userId: { $in: ids.map(String) } });
      await client.close();
      await new Promise((resolve) => server.close(resolve));
      await closeDB();
      console.log("\ncleanup: throwaway users removed, servers closed");
    }
    break mock;
  }

  console.log(`\n${failures === 0 ? "PROFILE-IMAGE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("profile-image test crashed:", e);
  process.exit(1);
});
