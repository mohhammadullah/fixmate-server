/**
 * FixMate technician-application workflow test (development only).
 *
 * Verifies the full lifecycle end-to-end against a locally running server
 * (default http://localhost:5000) with a real MongoDB database:
 * submission, validation, duplicate pending prevention, own status,
 * admin-only listing/filtering/pagination, approval (role promotion),
 * rejection (role preserved), resubmission, invalid transitions and the
 * impossibility of client-side role escalation. Throwaway accounts are
 * created through public signup and removed on completion.
 *
 * Required env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Optional env: BASE_URL, TEST_ORIGIN.
 * Usage: node scripts/technician-applications-test.mjs
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

const validApplication = {
  phone: "+1 555 010 2030",
  area: "Central District",
  experience: 5,
  skills: ["Mobile Repair", "Diagnostics"],
  bio: "I have repaired phones and laptops for five years and enjoy helping customers.",
};

const makeUser = async (db, label, role = "customer") => {
  const email = `fixmate.app.${label}.${Date.now()}@example.com`;
  const password = crypto.randomUUID() + "Aa1!";
  const name = `FixMate App ${label}`;
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email, password, name }),
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`signup failed for ${label}: ${signup.status} ${JSON.stringify(signup.body)}`);
  }
  if (role !== "customer") {
    const users = db.collection("user");
    await users.updateOne({ email }, { $set: { role } });
  }
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) throw new Error(`signin failed for ${label}: ${signin.status}`);
  const cookie = signin.headers.getSetCookie?.() ?? [];
  const sessionCookie = cookie.find((c) => c.includes("session_token"))?.split(";")[0];
  if (!sessionCookie) throw new Error(`no session cookie for ${label}`);
  const tokenRes = await api("/api/auth/token", { headers: { cookie: sessionCookie } });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`JWT failed for ${label}: ${tokenRes.status}`);
  }
  const user = await db.collection("user").findOne({ email });
  return {
    email,
    password,
    name,
    userId: user._id,
    token: tokenRes.body.token,
    sessionCookie,
  };
};

const refreshToken = async (account) => {
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (signin.status !== 200) throw new Error(`re-signin failed for ${account.email}: ${signin.status}`);
  const tokenRes = await api("/api/auth/token", {
    headers: { cookie: account.sessionCookie },
  });
  if (tokenRes.status !== 200 || typeof tokenRes.body?.token !== "string") {
    throw new Error(`JWT refresh failed for ${account.email}: ${tokenRes.status}`);
  }
  return tokenRes.body.token;
};

const auth = (token) => ({ ...jsonHeaders, authorization: `Bearer ${token}` });

const main = async () => {
  console.log(`Technician-applications test against ${BASE_URL}\n`);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);

  const applicant = await makeUser(db, "applicant");
  const second = await makeUser(db, "second");
  const admin = await makeUser(db, "admin", "admin");
  console.log(`throwaway users created: applicant, second, admin\n`);

  try {
    // --- Own status before applying ---
    console.log("[own status: none]");
    const before = await api("/api/technician-applications/my", {
      headers: auth(applicant.token),
    });
    check(before.status === 200 && before.body?.data === null, `GET /my -> 200 with null data (${before.status})`);

    // --- Validation + role escalation attempts ---
    console.log("\n[validation]");
    const badBio = await api("/api/technician-applications", {
      method: "POST",
      headers: auth(applicant.token),
      body: JSON.stringify({ ...validApplication, bio: "too short" }),
    });
    check(badBio.status === 400 && badBio.body?.success === false, `short bio -> ${badBio.status} (expected 400)`);
    const badSkills = await api("/api/technician-applications", {
      method: "POST",
      headers: auth(applicant.token),
      body: JSON.stringify({ ...validApplication, skills: [] }),
    });
    check(badSkills.status === 400, `empty skills -> ${badSkills.status} (expected 400)`);
    const escalation = await api("/api/technician-applications", {
      method: "POST",
      headers: auth(applicant.token),
      body: JSON.stringify({ ...validApplication, role: "admin", status: "approved" }),
    });
    check(escalation.status === 400, `role/status in body -> ${escalation.status} (expected 400 strict)`);

    // --- Unauthenticated / non-customer access ---
    console.log("\n[authorization]");
    const anon = await api("/api/technician-applications", { method: "GET" });
    check(anon.status === 401, `admin list without token -> ${anon.status} (expected 401)`);
    const customerList = await api("/api/technician-applications", {
      headers: auth(applicant.token),
    });
    check(customerList.status === 403, `admin list as customer -> ${customerList.status} (expected 403)`);
    const customerReview = await api(`/api/technician-applications/${applicant.userId}/review`, {
      method: "PATCH",
      headers: auth(applicant.token),
      body: JSON.stringify({ decision: "approve" }),
    });
    check(customerReview.status === 403, `review as customer -> ${customerReview.status} (expected 403)`);

    // --- Submission + duplicate pending prevention ---
    console.log("\n[submission]");
    const submitted = await api("/api/technician-applications", {
      method: "POST",
      headers: auth(applicant.token),
      body: JSON.stringify(validApplication),
    });
    check(submitted.status === 200 && submitted.body?.data?.status === "pending", `valid submit -> ${submitted.status} pending (expected 200)`);
    check(submitted.body?.data?.phone === validApplication.phone, "owner DTO includes profile phone");
    const duplicate = await api("/api/technician-applications", {
      method: "POST",
      headers: auth(applicant.token),
      body: JSON.stringify(validApplication),
    });
    check(duplicate.status === 409, `duplicate pending submit -> ${duplicate.status} (expected 409)`);
    const own = await api("/api/technician-applications/my", {
      headers: auth(applicant.token),
    });
    check(own.status === 200 && own.body?.data?.status === "pending", `GET /my after submit -> pending (${own.status})`);
    check(own.body?.data?.skills?.length === 2, "own DTO includes skills");

    // A second pending application is needed for pagination checks.
    const secondSubmitted = await api("/api/technician-applications", {
      method: "POST",
      headers: auth(second.token),
      body: JSON.stringify(validApplication),
    });
    check(secondSubmitted.status === 200, `second applicant submitted -> ${secondSubmitted.status} (expected 200)`);

    // --- Admin listing, filters and pagination ---
    console.log("\n[admin listing]");
    const list = await api("/api/technician-applications?status=pending&page=1&limit=1", {
      headers: auth(admin.token),
    });
    check(list.status === 200 && list.body?.success === true, `admin list -> ${list.status} (expected 200)`);
    check(list.body?.data?.length === 1, "limit=1 returned one application");
    check(list.body?.pagination?.totalItems >= 2, "pagination totalItems present");
    check(list.body?.pagination?.hasNextPage === true, "pagination hasNextPage true with more items");
    const item = list.body?.data?.[0] ?? {};
    check(typeof item.name === "string" && typeof item.email === "string", "safe applicant name/email present");
    const leaked = ["password", "passwordHash", "session", "account"].filter((key) => key in item);
    check(leaked.length === 0, `admin DTO excludes auth internals (found: ${leaked.join(", ") || "none"})`);
    const badFilter = await api("/api/technician-applications?status=bogus", {
      headers: auth(admin.token),
    });
    check(badFilter.status === 400, `invalid status filter -> ${badFilter.status} (expected 400)`);
    const badPage = await api("/api/technician-applications?page=0", {
      headers: auth(admin.token),
    });
    check(badPage.status === 400, `page=0 -> ${badPage.status} (expected 400)`);

    // --- Rejection preserves customer role, reason is visible ---
    console.log("\n[rejection]");
    const missingReason = await api(`/api/technician-applications/${second.userId}/review`, {
      method: "PATCH",
      headers: auth(admin.token),
      body: JSON.stringify({ decision: "reject" }),
    });
    check(missingReason.status === 400, `reject without reason -> ${missingReason.status} (expected 400)`);
    const badDecision = await api(`/api/technician-applications/${second.userId}/review`, {
      method: "PATCH",
      headers: auth(admin.token),
      body: JSON.stringify({ decision: "promote" }),
    });
    check(badDecision.status === 400, `unknown decision -> ${badDecision.status} (expected 400)`);
    const rejected = await api(`/api/technician-applications/${second.userId}/review`, {
      method: "PATCH",
      headers: auth(admin.token),
      body: JSON.stringify({ decision: "reject", rejectionReason: "Needs more hands-on experience." }),
    });
    check(rejected.status === 200 && rejected.body?.data?.status === "rejected", `reject -> ${rejected.status} (expected 200)`);
    const secondUser = await db.collection("user").findOne({ _id: second.userId });
    check(secondUser?.role === "customer", "rejection preserves customer role");
    const rejectedAgain = await api(`/api/technician-applications/${second.userId}/review`, {
      method: "PATCH",
      headers: auth(admin.token),
      body: JSON.stringify({ decision: "approve" }),
    });
    check(rejectedAgain.status === 409, `review already rejected -> ${rejectedAgain.status} (expected 409)`);
    const secondOwn = await api("/api/technician-applications/my", {
      headers: auth(second.token),
    });
    check(secondOwn.body?.data?.rejectionReason === "Needs more hands-on experience.", "rejection reason visible to applicant");

    // --- Resubmission after rejection ---
    const resubmitted = await api("/api/technician-applications", {
      method: "POST",
      headers: auth(second.token),
      body: JSON.stringify(validApplication),
    });
    check(resubmitted.status === 200 && resubmitted.body?.data?.status === "pending", `resubmit after rejection -> ${resubmitted.status} pending`);

    // --- Approval promotes role atomically ---
    console.log("\n[approval]");
    const invalidId = await api("/api/technician-applications/not-an-id/review", {
      method: "PATCH",
      headers: auth(admin.token),
      body: JSON.stringify({ decision: "approve" }),
    });
    check(invalidId.status === 400, `invalid applicant id -> ${invalidId.status} (expected 400)`);
    const missingUser = await api(`/api/technician-applications/${new ObjectId().toHexString()}/review`, {
      method: "PATCH",
      headers: auth(admin.token),
      body: JSON.stringify({ decision: "approve" }),
    });
    check(missingUser.status === 404, `unknown applicant -> ${missingUser.status} (expected 404)`);
    const approved = await api(`/api/technician-applications/${applicant.userId}/review`, {
      method: "PATCH",
      headers: auth(admin.token),
      body: JSON.stringify({ decision: "approve" }),
    });
    check(approved.status === 200 && approved.body?.data?.status === "approved", `approve -> ${approved.status} (expected 200)`);
    check(approved.body?.data?.role === "technician", "approve response reports technician role");
    const applicantUser = await db.collection("user").findOne({ _id: applicant.userId });
    check(applicantUser?.role === "technician", "approval promotes stored role to technician");
    check(applicantUser?.technicianApplication?.reviewedBy?.equals(admin.userId) === true, "reviewedBy is the authenticated admin id");
    const approvedAgain = await api(`/api/technician-applications/${applicant.userId}/review`, {
      method: "PATCH",
      headers: auth(admin.token),
      body: JSON.stringify({ decision: "reject", rejectionReason: "Too late." }),
    });
    check(approvedAgain.status === 409, `review already approved -> ${approvedAgain.status} (expected 409)`);
    // The role claim is snapshotted in each JWT; fetch a fresh one after
    // the promotion (the app does this on every request).
    const technicianToken = await refreshToken(applicant);
    const technicianSubmit = await api("/api/technician-applications", {
      method: "POST",
      headers: auth(technicianToken),
      body: JSON.stringify(validApplication),
    });
    check(technicianSubmit.status === 403, `technician submitting application -> ${technicianSubmit.status} (expected 403)`);
  } finally {
    const users = db.collection("user");
    const sessions = db.collection("session");
    const accounts = db.collection("account");
    const ids = [applicant.userId, second.userId, admin.userId];
    await users.deleteMany({ _id: { $in: ids } });
    await sessions.deleteMany({ userId: { $in: ids.map(String) } });
    await accounts.deleteMany({ userId: { $in: ids.map(String) } });
    console.log("\ncleanup: throwaway users removed");
    await client.close();
  }

  console.log(`\n${failures === 0 ? "TECHNICIAN-APPLICATION CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error("technician-applications test crashed:", e);
  try {
    await client.close();
  } catch {}
  process.exit(1);
});
