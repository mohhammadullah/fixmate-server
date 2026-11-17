/**
 * FixMate public service-details endpoint test (development only).
 *
 * Verifies GET /api/services/:id end-to-end against a locally running server
 * (default http://localhost:5000) with a real MongoDB database. Seeds
 * services directly in MongoDB (approved+available, unavailable, pending and
 * rejected), checks the public response and private-field projection, and
 * removes the seeded documents when finished. No authentication is used —
 * the endpoint is public.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/service-details-test.mjs
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";

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

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual", ...options });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
});

const main = async () => {
  console.log(`Service-details test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const services = db.collection("services");

  const now = new Date();
  const technicianId = new ObjectId();
  const baseService = {
    title: "Seeded Detail Test Repair",
    category: "Mobile Repair",
    description: "A seeded description used by the service-details test.",
    overview: "A seeded overview used by the service-details test.",
    hourlyRate: 49,
    securityDeposit: 25,
    maxCapacity: 3,
    location: "Seeded City",
    image: "https://example.com/seeded-detail.jpg",
    amenities: ["Home visit", "Warranty"],
    technicianId,
    technicianName: "Seeded Technician",
    technicianEmail: "seeded.technician@example.com",
    approvalStatus: "approved",
    availabilityStatus: "available",
    createdAt: now,
    updatedAt: now,
  };

  const okId = new ObjectId();
  const unavailableId = new ObjectId();
  const pendingId = new ObjectId();
  const rejectedId = new ObjectId();

  await services.insertMany([
    // Include a rejectionReason on the visible service: the projection must
    // strip it even when the field happens to exist on the document.
    {
      _id: okId,
      ...baseService,
      rejectionReason: "SENSITIVE-INTERNAL-REASON",
    },
    { _id: unavailableId, ...baseService, availabilityStatus: "unavailable" },
    { _id: pendingId, ...baseService, approvalStatus: "pending" },
    {
      _id: rejectedId,
      ...baseService,
      approvalStatus: "rejected",
      rejectionReason: "SENSITIVE-INTERNAL-REASON",
    },
  ]);
  console.log(
    `seeded services: ok=${okId.toHexString()} unavailable=${unavailableId.toHexString()} pending=${pendingId.toHexString()} rejected=${rejectedId.toHexString()}\n`
  );

  try {
    // --- Invalid id -> 400 ---
    console.log("[invalid id]");
    const bad = await api("/api/services/not-an-object-id");
    check(bad.status === 400 && bad.body?.success === false, `invalid id -> ${bad.status} (expected 400)`);
    const short = await api("/api/services/0123456789ab");
    check(short.status === 400, `12-byte hex id -> ${short.status} (expected 400)`);

    // --- Missing service -> 404 ---
    console.log("\n[not found]");
    const missing = await api(`/api/services/${new ObjectId().toHexString()}`);
    check(missing.status === 404, `random id -> ${missing.status} (expected 404)`);

    // --- Unapproved / unavailable -> 404 (indistinguishable from missing) ---
    console.log("\n[filtered out]");
    const unapproved = await api(`/api/services/${pendingId.toHexString()}`);
    check(unapproved.status === 404, `pending service -> ${unapproved.status} (expected 404)`);
    const unavailable = await api(`/api/services/${unavailableId.toHexString()}`);
    check(unavailable.status === 404, `unavailable service -> ${unavailable.status} (expected 404)`);
    const rejected = await api(`/api/services/${rejectedId.toHexString()}`);
    check(rejected.status === 404, `rejected service -> ${rejected.status} (expected 404)`);

    // --- Valid service -> 200 with safe public projection ---
    console.log("\n[valid service]");
    const ok = await api(`/api/services/${okId.toHexString()}`);
    check(ok.status === 200 && ok.body?.success === true, `approved+available -> ${ok.status} (expected 200)`);

    const dto = ok.body?.data ?? {};
    check(dto._id === okId.toHexString(), "dto._id matches requested id");
    check(dto.title === baseService.title, "dto.title present");
    check(dto.category === baseService.category, "dto.category present");
    check(dto.description === baseService.description, "dto.description present");
    check(dto.overview === baseService.overview, "dto.overview present");
    check(dto.hourlyRate === baseService.hourlyRate, "dto.hourlyRate present");
    check(dto.securityDeposit === baseService.securityDeposit, "dto.securityDeposit present");
    check(dto.maxCapacity === baseService.maxCapacity, "dto.maxCapacity present");
    check(dto.location === baseService.location, "dto.location present");
    check(dto.image === baseService.image, "dto.image present");
    check(Array.isArray(dto.amenities) && dto.amenities.length === 2, "dto.amenities present");
    check(dto.technicianName === baseService.technicianName, "dto.technicianName present");

    const leaked = [
      "technicianId",
      "technicianEmail",
      "rejectionReason",
    ].filter((key) => key in dto);
    check(leaked.length === 0, `private fields excluded (found: ${leaked.join(", ") || "none"})`);

    // --- Public listing unaffected (route ordering / no contract change) ---
    console.log("\n[public listing]");
    const listing = await api("/api/services?search=Seeded%20Detail%20Test%20Repair&limit=50");
    check(listing.status === 200 && listing.body?.success === true, `GET /api/services -> ${listing.status} (expected 200)`);
    const listed = (listing.body?.data ?? []).some((s) => s._id === okId.toHexString());
    check(listed, "seeded visible service appears in public listing");
    const listedPrivate = (listing.body?.data ?? []).some(
      (s) => "technicianId" in s || "technicianEmail" in s || "rejectionReason" in s
    );
    check(!listedPrivate, "public listing still excludes private fields");
  } finally {
    await services.deleteMany({
      _id: { $in: [okId, unavailableId, pendingId, rejectedId] },
    });
    console.log("\ncleanup: seeded services removed");
    await client.close();
  }

  console.log(`\n${failures === 0 ? "SERVICE-DETAILS CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("service-details test crashed:", e);
  try {
    await client.close();
  } catch {}
  process.exit(1);
});
