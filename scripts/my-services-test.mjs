/**
 * FixMate "my services" endpoint test (development only).
 *
 * Verifies GET /api/services/my (technician-owned, safe DTO) end-to-end
 * against a locally running server (default http://localhost:5000) with a
 * real MongoDB database. Seeds services directly in MongoDB — five owned by
 * the signed-in account, one owned by a fabricated other technician — and
 * removes them when the script finishes. Roles are switched in the user
 * document (and JWTs refetched, since role is embedded at issuance time),
 * the same approach as role-matrix-test.mjs.
 *
 * Auth: when TEST_USER_PASSWORD is set, the shared dev test account is used
 * (TEST_USER_EMAIL, default fixmate.test@example.com). Otherwise the script
 * creates its own throwaway account through the public signup path (role is
 * "customer" at signup and switched as needed), exercises it, and deletes it
 * afterwards.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: TEST_USER_EMAIL, TEST_USER_PASSWORD, BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/my-services-test.mjs
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const MANAGED_ACCOUNT = !process.env.TEST_USER_PASSWORD;
const TEST_EMAIL = MANAGED_ACCOUNT
  ? `fixmate.myservices.test.${Date.now()}@example.com`
  : (process.env.TEST_USER_EMAIL ?? "fixmate.test@example.com");
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? crypto.randomUUID() + "Aa1!";
const TEST_NAME = "FixMate My Services Test";

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
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

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

const getJwt = async (sessionCookie) => {
  const tokenRes = await api("/api/auth/token", {
    headers: { cookie: sessionCookie },
  });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`could not obtain JWT (status ${tokenRes.status})`);
  }
  return tokenRes.body.token;
};

const authFor = (token) => ({ headers: { authorization: `Bearer ${token}` } });

const HOUR = 60 * 60 * 1000;

const main = async () => {
  console.log(`My-services test against ${BASE_URL}`);
  console.log(`Test account: ${TEST_EMAIL}\n`);

  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const users = db.collection("user");
  const sessions = db.collection("session");
  const accounts = db.collection("account");
  const services = db.collection("services");

  if (MANAGED_ACCOUNT) {
    console.log(`creating throwaway test account ${TEST_EMAIL}`);
    const signup = await api("/api/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME }),
    });
    if (signup.status !== 200 && signup.status !== 201) {
      throw new Error(`signup failed with status ${signup.status}: ${JSON.stringify(signup.body)}`);
    }
  }

  const testUser = await users.findOne({ email: TEST_EMAIL });
  if (!testUser) {
    throw new Error(`test user ${TEST_EMAIL} not found — run scripts/smoke-test.mjs first`);
  }
  const technicianId = testUser._id;
  const originalRole = testUser.role ?? "customer";

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

  // --- Seed services (distinct createdAt so sort order is observable) ---
  const now = Date.now();
  const otherTechnicianId = new ObjectId();
  const seed = (name, overrides) => ({
    _id: new ObjectId(),
    title: `Seeded ${name}`,
    category: "AC Repair",
    description: "Seeded description for the my-services test.",
    overview: "Seeded overview for the my-services test.",
    hourlyRate: 45,
    securityDeposit: 50,
    maxCapacity: 2,
    location: "Seeded Location",
    image: "https://example.com/seeded.jpg",
    amenities: ["Seeded amenity"],
    technicianId,
    technicianName: TEST_NAME,
    technicianEmail: TEST_EMAIL,
    approvalStatus: "approved",
    availabilityStatus: "available",
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  });

  const own = [
    seed("Alpha", { approvalStatus: "approved", availabilityStatus: "available", createdAt: new Date(now - 1 * HOUR) }),
    seed("Bravo", { approvalStatus: "pending", availabilityStatus: "available", createdAt: new Date(now - 2 * HOUR) }),
    seed("Charlie", { approvalStatus: "rejected", availabilityStatus: "unavailable", createdAt: new Date(now - 3 * HOUR) }),
    seed("Delta", { approvalStatus: "approved", availabilityStatus: "unavailable", createdAt: new Date(now - 4 * HOUR) }),
    seed("Echo", { approvalStatus: "pending", availabilityStatus: "available", createdAt: new Date(now - 5 * HOUR) }),
  ];
  const foreign = seed("Foreign", {
    technicianId: otherTechnicianId,
    technicianName: "Other Technician",
    technicianEmail: "other.technician@example.com",
  });
  const seededIds = [...own.map((s) => s._id), foreign._id];

  await services.insertMany([...own, foreign]);
  console.log(`seeded ${own.length} own services + 1 foreign service\n`);

  const switchRole = async (role) => {
    await users.updateOne({ _id: technicianId }, { $set: { role } });
    return getJwt(sessionCookie);
  };

  try {
    // --- Unauthenticated -> 401 ---
    console.log("[unauthenticated]");
    const anon = await api("/api/services/my");
    check(anon.status === 401, `GET /api/services/my without token -> ${anon.status} (expected 401)`);

    // --- Customer -> 403 ---
    console.log("\n[customer role]");
    await users.updateOne({ _id: technicianId }, { $set: { role: "customer" } });
    const customerToken = await getJwt(sessionCookie);
    const asCustomer = await api("/api/services/my", authFor(customerToken));
    check(asCustomer.status === 403, `GET /api/services/my as customer -> ${asCustomer.status} (expected 403)`);

    // --- Admin -> 403 ---
    console.log("\n[admin role]");
    const adminToken = await switchRole("admin");
    const asAdmin = await api("/api/services/my", authFor(adminToken));
    check(asAdmin.status === 403, `GET /api/services/my as admin -> ${asAdmin.status} (expected 403)`);

    // --- Technician ---
    const techToken = await switchRole("technician");
    const auth = authFor(techToken);

    console.log("\n[technician: ownership]");
    const mine = await api("/api/services/my", auth);
    check(mine.status === 200 && mine.body?.success === true, `GET /api/services/my -> ${mine.status} (expected 200)`);
    const items = mine.body?.data ?? [];
    check(items.length === own.length, `returned ${items?.length} services (expected ${own.length} own services)`);
    const returnedIds = new Set(items.map((s) => s.id));
    check(
      own.every((s) => returnedIds.has(s._id.toHexString())),
      "all own seeded services are returned"
    );
    check(!returnedIds.has(foreign._id.toHexString()), "another technician's service is not returned");

    // technicianId in the query string must be ignored
    const withParam = await api(`/api/services/my?technicianId=${otherTechnicianId.toHexString()}`, auth);
    const withParamIds = new Set((withParam.body?.data ?? []).map((s) => s.id));
    check(
      withParam.status === 200 && !withParamIds.has(foreign._id.toHexString()) && withParamIds.size === own.length,
      "technicianId query param is ignored"
    );

    console.log("\n[technician: approvalStatus filter]");
    const statuses = new Set(items.map((s) => s.approvalStatus));
    check(
      statuses.has("pending") && statuses.has("approved") && statuses.has("rejected"),
      "pending, approved and rejected services are all returned without a filter"
    );
    for (const [status, expected] of [["approved", 2], ["pending", 2], ["rejected", 1]]) {
      const res = await api(`/api/services/my?approvalStatus=${status}`, auth);
      check(
        res.status === 200 && res.body?.data?.length === expected &&
          res.body.data.every((s) => s.approvalStatus === status),
        `approvalStatus=${status} -> ${res.body?.data?.length} item(s) (expected ${expected})`
      );
    }

    console.log("\n[technician: isAvailable filter]");
    const availTrue = await api("/api/services/my?isAvailable=true", auth);
    check(
      availTrue.status === 200 && availTrue.body?.data?.length === 3 &&
        availTrue.body.data.every((s) => s.isAvailable === true),
      `isAvailable=true -> ${availTrue.body?.data?.length} item(s) (expected 3)`
    );
    const availFalse = await api("/api/services/my?isAvailable=false", auth);
    check(
      availFalse.status === 200 && availFalse.body?.data?.length === 2 &&
        availFalse.body.data.every((s) => s.isAvailable === false),
      `isAvailable=false -> ${availFalse.body?.data?.length} item(s) (expected 2)`
    );

    console.log("\n[technician: sorting]");
    const createdAts = items.map((s) => new Date(s.createdAt).getTime());
    check(
      createdAts.every((t, i) => i === 0 || createdAts[i - 1] >= t),
      "services are sorted newest first"
    );

    console.log("\n[technician: pagination]");
    const page1 = await api("/api/services/my?limit=2&page=1", auth);
    const page3 = await api("/api/services/my?limit=2&page=3", auth);
    check(
      page1.status === 200 && page1.body?.data?.length === 2 &&
        page1.body?.pagination?.totalItems === 5 &&
        page1.body?.pagination?.totalPages === 3 &&
        page1.body?.pagination?.hasNextPage === true &&
        page1.body?.pagination?.hasPrevPage === false,
      "page 1 (limit 2) returns 2 items with correct pagination metadata"
    );
    check(
      page3.status === 200 && page3.body?.data?.length === 1 &&
        page3.body?.pagination?.hasNextPage === false &&
        page3.body?.pagination?.hasPrevPage === true &&
        page3.body?.pagination?.currentPage === 3,
      "page 3 (limit 2) returns the last item with correct pagination metadata"
    );
    const defaults = await api("/api/services/my", auth);
    check(
      defaults.body?.pagination?.limit === 10 && defaults.body?.pagination?.currentPage === 1,
      "default page=1 and limit=10 applied"
    );

    console.log("\n[technician: invalid query values]");
    for (const [label, query] of [
      ["page=0", "page=0"],
      ["page=abc", "page=abc"],
      ["limit=0", "limit=0"],
      ["limit=51", "limit=51"],
      ["limit=abc", "limit=abc"],
      ["approvalStatus=bogus", "approvalStatus=bogus"],
      ["isAvailable=yes", "isAvailable=yes"],
    ]) {
      const res = await api(`/api/services/my?${query}`, auth);
      check(res.status === 400, `GET /api/services/my?${label} -> ${res.status} (expected 400)`);
    }

    console.log("\n[technician: DTO safety]");
    const dto = items[0] ?? {};
    const requiredKeys = [
      "id", "title", "category", "location", "image", "hourlyRate",
      "securityDeposit", "maxCapacity", "amenities", "overview",
      "approvalStatus", "isAvailable", "createdAt", "updatedAt",
    ];
    check(
      requiredKeys.every((key) => key in dto),
      "DTO contains all required fields"
    );
    const forbiddenKeys = [
      "_id", "technicianId", "technicianName", "technicianEmail",
      "availabilityStatus", "rejectionReason", "description",
    ];
    const leaked = forbiddenKeys.filter((key) => key in dto);
    check(leaked.length === 0, `DTO exposes no internal/account keys (found: ${leaked.join(", ") || "none"})`);
    check(typeof dto.id === "string" && !("_id" in dto), "DTO id is a string, _id is absent");
  } finally {
    await services.deleteMany({ _id: { $in: seededIds } });
    await users.updateOne({ _id: technicianId }, { $set: { role: originalRole } });
    console.log("\ncleanup: seeded services removed, role restored");
    if (MANAGED_ACCOUNT) {
      await sessions.deleteMany({ userId: technicianId });
      await accounts.deleteMany({ userId: technicianId });
      await users.deleteOne({ _id: technicianId });
      console.log("cleanup: throwaway test account deleted");
    }
    await client.close();
  }

  console.log(`\n${failures === 0 ? "MY-SERVICES CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("my-services test crashed:", e);
  try {
    await client.close();
  } catch {}
  process.exit(1);
});
