/**
 * FixMate — technician service edit regression test (development only, isolated).
 *
 * Self-contained: boots its own API on an ephemeral port with a temporary
 * throwaway MongoDB database. Seeds throwaway users/services only and drops the
 * temporary database on completion.
 *
 * Verifies the service edit flow end-to-end:
 * - GET /api/services/my/:id returns the owning technician's editable service
 *   (including description) and rejects unauth/customer/other technician/invalid id.
 * - PATCH /api/services/:id allows the owner to edit, resets approvalStatus to
 *   "pending", preserves fields when omitted/unchanged (including image), returns
 *   correct updated data, and rejects unauth/customer/other technician/invalid id
 *   and invalid payloads without 500s.
 *
 * Required env: MONGODB_URI (from .env).
 * Optional env: MONGODB_DB_NAME (base name; temp DB derives from it), TEST_ORIGIN.
 * Usage: node scripts/service-edit-test.mjs
 */
import "dotenv/config";
import http from "node:http";
import net from "node:net";
import { MongoClient, ObjectId } from "mongodb";

const TEST_ORIGIN = process.env.TEST_ORIGIN ?? "http://localhost:3000";
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const tempDbName = `fm_se_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Must be set before importing dist env/db modules.
process.env.MONGODB_DB_NAME = tempDbName;
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:65535";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_mock_placeholder";
process.env.STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_mock_test_secret_0123456789";
process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";

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

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const jsonHeaders = (token) => ({
  "content-type": "application/json",
  origin: TEST_ORIGIN,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const api = async (base, path, options = {}) => {
  const res = await fetch(`${base}${path}`, { redirect: "manual", ...options });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
};

const getJwt = async (base, sessionCookie) => {
  const tokenRes = await api(base, "/api/auth/token", {
    headers: { cookie: sessionCookie },
  });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`could not obtain JWT (status ${tokenRes.status})`);
  }
  return tokenRes.body.token;
};

const makeUser = async (base, db, label, role = "customer") => {
  const email = `fixmate.service.edit.${label}.${runId}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const name = `FixMate Edit ${label}`;
  const signup = await api(base, "/api/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password, name }),
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`signup ${label} failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  }
  const user = await db.collection("user").findOne({ email });
  if (!user) throw new Error(`user ${label} not found after signup`);
  if (role !== "customer") {
    await db.collection("user").updateOne({ _id: user._id }, { $set: { role } });
  }
  const signin = await api(base, "/api/auth/sign-in/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) {
    throw new Error(`signin ${label} failed: ${signin.status} ${JSON.stringify(signin.body)}`);
  }
  const cookie = (signin.headers.getSetCookie?.() ?? [])
    .find((c) => c.includes("session_token"))
    ?.split(";")[0];
  if (!cookie) throw new Error(`no session cookie for ${label}`);
  const token = await getJwt(base, cookie);
  return { email, password, name, userId: user._id, cookie, token };
};

const main = async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI must be set (via .env).");
    process.exit(1);
  }

  const appPort = await getFreePort();
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${appPort}`;
  const APP_BASE = `http://127.0.0.1:${appPort}`;

  console.log(`Service edit isolated test (API :${appPort}, temp DB ${tempDbName})\n`);

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
    server.listen(appPort, "127.0.0.1", resolve);
  });

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const db = client.db(tempDbName);
  const services = db.collection("services");

  let tempDbDropped = false;
  try {
    console.log("[setup]");
    const owner = await makeUser(APP_BASE, db, "owner", "technician");
    const otherTech = await makeUser(APP_BASE, db, "other-tech", "technician");
    const customer = await makeUser(APP_BASE, db, "customer", "customer");
    // Re-fetch JWTs after role updates were applied before signin cookie/token in makeUser;
    // ensure role is embedded correctly by minting fresh tokens from session cookies.
    await db.collection("user").updateMany(
      { _id: { $in: [owner.userId, otherTech.userId] } },
      { $set: { role: "technician" } }
    );
    await db.collection("user").updateOne({ _id: customer.userId }, { $set: { role: "customer" } });
    owner.token = await getJwt(APP_BASE, owner.cookie);
    otherTech.token = await getJwt(APP_BASE, otherTech.cookie);
    customer.token = await getJwt(APP_BASE, customer.cookie);

    const now = new Date();
    const ownServiceId = new ObjectId();
    const foreignServiceId = new ObjectId();
    const ownService = {
      _id: ownServiceId,
      title: "Original AC Repair",
      category: "AC Repair",
      description: "Original seeded description for service edit regression test.",
      overview: "Original seeded overview for service edit regression test.",
      hourlyRate: 45,
      securityDeposit: 50,
      maxCapacity: 2,
      location: "Seeded Location",
      image: "https://example.com/original-service.jpg",
      amenities: ["Seeded amenity"],
      technicianId: owner.userId,
      technicianName: owner.name,
      technicianEmail: owner.email,
      approvalStatus: "approved",
      availabilityStatus: "available",
      createdAt: now,
      updatedAt: now,
    };
    const foreignService = {
      _id: foreignServiceId,
      title: "Other Technician Service",
      category: "AC Repair",
      description: "Foreign service description should never be editable.",
      overview: "Foreign service overview should never be editable.",
      hourlyRate: 60,
      securityDeposit: 20,
      maxCapacity: 1,
      location: "Other Location",
      image: "https://example.com/foreign-service.jpg",
      amenities: ["Other amenity"],
      technicianId: otherTech.userId,
      technicianName: otherTech.name,
      technicianEmail: otherTech.email,
      approvalStatus: "approved",
      availabilityStatus: "available",
      createdAt: now,
      updatedAt: now,
    };
    await services.insertMany([ownService, foreignService]);
    console.log("  seeded owner/other technician/customer and 2 throwaway services\n");

    const ownerAuth = { headers: jsonHeaders(owner.token) };
    const otherAuth = { headers: jsonHeaders(otherTech.token) };
    const customerAuth = { headers: jsonHeaders(customer.token) };
    const ownPath = `/api/services/my/${ownServiceId.toHexString()}`;
    const foreignPath = `/api/services/my/${foreignServiceId.toHexString()}`;
    const ownPatchPath = `/api/services/${ownServiceId.toHexString()}`;
    const foreignPatchPath = `/api/services/${foreignServiceId.toHexString()}`;

    console.log("[load own service for edit]");
    const anonLoad = await api(APP_BASE, ownPath);
    check(anonLoad.status === 401, `GET own service without token -> ${anonLoad.status} (expected 401)`);
    const customerLoad = await api(APP_BASE, ownPath, customerAuth);
    check(customerLoad.status === 403, `GET own service as customer -> ${customerLoad.status} (expected 403)`);
    const otherLoad = await api(APP_BASE, ownPath, otherAuth);
    check(otherLoad.status === 404, `GET another technician's service -> ${otherLoad.status} (expected 404 indistinguishable)`);
    const badIdLoad = await api(APP_BASE, "/api/services/my/not-an-id", ownerAuth);
    check(badIdLoad.status === 400, `GET with invalid service id -> ${badIdLoad.status} (expected 400)`);

    const load = await api(APP_BASE, ownPath, ownerAuth);
    check(load.status === 200 && load.body?.success === true, `owner GET own service -> ${load.status}`);
    const loaded = load.body?.data ?? {};
    check(loaded.id === ownServiceId.toHexString(), "loaded service has correct id");
    check(
      loaded.description === ownService.description,
      "loaded service includes description for prefill"
    );
    for (const key of [
      "title", "category", "location", "image", "hourlyRate",
      "securityDeposit", "maxCapacity", "amenities", "overview",
      "approvalStatus", "isAvailable", "createdAt", "updatedAt",
    ]) {
      check(key in loaded, `loaded service includes ${key}`);
    }
    for (const forbidden of ["_id", "technicianId", "technicianName", "technicianEmail", "rejectionReason"]) {
      check(!(forbidden in loaded), `edit DTO excludes ${forbidden}`);
    }

    console.log("\n[update authorization and validation]");
    const anonPatch = await api(APP_BASE, ownPatchPath, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ title: "Hacked" }),
    });
    check(anonPatch.status === 401, `PATCH without token -> ${anonPatch.status} (expected 401)`);

    const customerPatch = await api(APP_BASE, ownPatchPath, {
      method: "PATCH",
      headers: { ...jsonHeaders(customer.token) },
      body: JSON.stringify({ title: "Hacked" }),
    });
    check(customerPatch.status === 403, `PATCH as customer -> ${customerPatch.status} (expected 403)`);

    const otherPatch = await api(APP_BASE, ownPatchPath, {
      method: "PATCH",
      headers: { ...jsonHeaders(otherTech.token) },
      body: JSON.stringify({ title: "Hacked by other tech" }),
    });
    check(
      otherPatch.status === 404,
      `PATCH another technician's service -> ${otherPatch.status} (expected 404 indistinguishable)`
    );
    const foreignAfterOther = await services.findOne({ _id: foreignServiceId });
    check(
      foreignAfterOther?.title === foreignService.title,
      "other technician cannot modify another owner's service"
    );

    const badIdPatch = await api(APP_BASE, "/api/services/not-an-id", {
      method: "PATCH",
      headers: { ...jsonHeaders(owner.token) },
      body: JSON.stringify({ title: "Valid Title" }),
    });
    check(badIdPatch.status === 400, `PATCH invalid service id -> ${badIdPatch.status} (expected 400)`);

    const badPayload = await api(APP_BASE, ownPatchPath, {
      method: "PATCH",
      headers: { ...jsonHeaders(owner.token) },
      body: JSON.stringify({ title: "ab" }),
    });
    check(
      badPayload.status === 400 && badPayload.body?.message === "Validation failed.",
      `PATCH invalid payload rejected with 400 -> ${badPayload.status} ${JSON.stringify(badPayload.body?.message)}`
    );

    const emptyPayload = await api(APP_BASE, ownPatchPath, {
      method: "PATCH",
      headers: { ...jsonHeaders(owner.token) },
      body: JSON.stringify({}),
    });
    check(emptyPayload.status === 400, `PATCH empty payload rejected -> ${emptyPayload.status} (expected 400)`);

    const unknownField = await api(APP_BASE, ownPatchPath, {
      method: "PATCH",
      headers: { ...jsonHeaders(owner.token) },
      body: JSON.stringify({ title: "Valid Updated Title", technicianId: owner.userId.toHexString() }),
    });
    check(unknownField.status === 400, `PATCH with unknown/server-controlled field rejected -> ${unknownField.status}`);

    console.log("\n[successful edit and persistence]");
    const patchBody = {
      title: "Updated AC Repair",
      category: "AC Repair",
      description: "Updated seeded description for service edit regression test.",
      overview: "Updated seeded overview for service edit regression test.",
      hourlyRate: 55,
      securityDeposit: 40,
      maxCapacity: 3,
      location: "Updated Location",
      amenities: ["Seeded amenity", "Updated amenity"],
      // image intentionally omitted: must remain unchanged
    };
    const ok = await api(APP_BASE, ownPatchPath, {
      method: "PATCH",
      headers: { ...jsonHeaders(owner.token) },
      body: JSON.stringify(patchBody),
    });
    check(ok.status === 200 && ok.body?.success === true, `owner PATCH -> ${ok.status}`);
    check(
      ok.body?.data?.title === patchBody.title && ok.body?.data?.location === patchBody.location,
      "PATCH response includes updated fields"
    );
    check(
      ok.body?.data?.approvalStatus === "pending",
      `PATCH resets approvalStatus to pending -> ${ok.body?.data?.approvalStatus}`
    );
    check(
      ok.body?.data?.image === ownService.image,
      "omitted image remains unchanged in PATCH response"
    );

    const after = await services.findOne({ _id: ownServiceId });
    check(after?.title === patchBody.title, "DB title updated");
    check(after?.description === patchBody.description, "DB description updated");
    check(after?.overview === patchBody.overview, "DB overview updated");
    check(after?.hourlyRate === patchBody.hourlyRate, "DB hourlyRate updated");
    check(after?.securityDeposit === patchBody.securityDeposit, "DB securityDeposit updated");
    check(after?.maxCapacity === patchBody.maxCapacity, "DB maxCapacity updated");
    check(after?.location === patchBody.location, "DB location updated");
    check(
      Array.isArray(after?.amenities) &&
        after.amenities.length === 2 &&
        after.amenities.includes("Updated amenity"),
      "DB amenities updated"
    );
    check(after?.image === ownService.image, "DB image remains unchanged when omitted");
    check(after?.approvalStatus === "pending", "DB approvalStatus reset to pending");
    check(
      after?.technicianId?.toHexString() === owner.userId.toHexString() &&
        after?.technicianName === owner.name &&
        after?.technicianEmail === owner.email,
      "ownership/identity fields remain intact"
    );
    check(
      after?.availabilityStatus === ownService.availabilityStatus,
      "availabilityStatus remains intact"
    );
    check(after?.updatedAt instanceof Date, "updatedAt is stored as Date");
    check(
      after?.updatedAt?.getTime() >= ownService.updatedAt.getTime(),
      "updatedAt advanced on edit"
    );

    // Partial update: omitted optional fields remain intact.
    console.log("\n[partial update preserves omitted fields]");
    const partial = await api(APP_BASE, ownPatchPath, {
      method: "PATCH",
      headers: { ...jsonHeaders(owner.token) },
      body: JSON.stringify({ title: "Partially Updated AC Repair" }),
    });
    check(partial.status === 200 && partial.body?.success === true, `partial PATCH -> ${partial.status}`);
    const afterPartial = await services.findOne({ _id: ownServiceId });
    check(afterPartial?.title === "Partially Updated AC Repair", "partial update changes provided field");
    check(afterPartial?.description === patchBody.description, "partial update preserves description");
    check(afterPartial?.overview === patchBody.overview, "partial update preserves overview");
    check(afterPartial?.location === patchBody.location, "partial update preserves location");
    check(afterPartial?.hourlyRate === patchBody.hourlyRate, "partial update preserves hourlyRate");
    check(afterPartial?.securityDeposit === patchBody.securityDeposit, "partial update preserves securityDeposit");
    check(afterPartial?.maxCapacity === patchBody.maxCapacity, "partial update preserves maxCapacity");
    check(afterPartial?.image === ownService.image, "partial update preserves image");
    check(
      Array.isArray(afterPartial?.amenities) && afterPartial.amenities.length === 2,
      "partial update preserves amenities"
    );
    check(afterPartial?.approvalStatus === "pending", "partial update keeps/resets approvalStatus to pending");

  } finally {
    console.log("\n[cleanup]");
    try {
      await db.dropDatabase();
      tempDbDropped = true;
      console.log(`  dropped temp DB ${tempDbName}`);
    } catch (e) {
      console.error(`  failed to drop temp DB ${tempDbName}:`, e);
    }
    await client.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    await closeDB().catch(() => undefined);
    console.log(
      `  cleanup ${tempDbDropped ? "complete (temp DB dropped)" : "incomplete (temp DB NOT dropped)"}`
    );
  }

  console.log(`\n${failures === 0 ? "SERVICE EDIT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error("service edit test crashed:", error);
  process.exit(1);
});
