/**
 * One-time, server-side admin bootstrap (development / deployment utility).
 *
 * Promotes an EXISTING Better Auth user (by exact email) to the admin role
 * and, if no Main Admin is designated yet, designates that user as the
 * Main Admin. It never creates users, never accepts a password, and is never
 * exposed through an HTTP endpoint. Public signup always assigns "customer".
 *
 * Recovery mode — designate an EXISTING Admin as Main Admin when no Main
 * Admin exists (e.g. the designated admin was lost):
 *   ADMIN_BOOTSTRAP_DESIGNATE_MAIN=true ADMIN_BOOTSTRAP_EMAIL=<existing admin email>
 *   ADMIN_BOOTSTRAP_CONFIRM=true
 * Refuses to run if a Main Admin already exists.
 *
 * Required env:
 *   ADMIN_BOOTSTRAP_EMAIL=<exact existing user email>
 *   ADMIN_BOOTSTRAP_CONFIRM=true
 *
 * Optional env: MONGODB_URI, MONGODB_DB_NAME (from .env).
 * Usage: npm run bootstrap:admin
 *
 * IMPORTANT: remove both ADMIN_BOOTSTRAP_* variables from the environment
 * after the promotion and restart the server.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const EMAIL = process.env.ADMIN_BOOTSTRAP_EMAIL;
const CONFIRM = process.env.ADMIN_BOOTSTRAP_CONFIRM;
const DESIGNATE_MAIN = process.env.ADMIN_BOOTSTRAP_DESIGNATE_MAIN === "true";

if (!EMAIL || EMAIL.trim() === "") {
  console.error("ADMIN_BOOTSTRAP_EMAIL must be set to the exact email of an existing user.");
  process.exit(1);
}
if (CONFIRM !== "true") {
  console.error(
    "Refusing to run: set ADMIN_BOOTSTRAP_CONFIRM=true to acknowledge this one-time promotion."
  );
  process.exit(1);
}
if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) {
  console.error("MONGODB_URI and MONGODB_DB_NAME must be set (via .env).");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
});

const main = async () => {
  await client.connect();
  const users = client.db(process.env.MONGODB_DB_NAME).collection("user");

  const matches = await users.find({ email: EMAIL }).limit(2).toArray();
  if (matches.length === 0) {
    console.error(`Refusing to run: no existing user with email "${EMAIL}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Refusing to run: ambiguous email "${EMAIL}" matched multiple users.`);
    process.exit(1);
  }

  const target = matches[0];

  // --- Designation recovery mode: an EXISTING admin becomes the Main Admin
  if (DESIGNATE_MAIN) {
    if (target.role !== "admin") {
      console.error(
        `Refusing to run: user "${EMAIL}" has role "${target.role}", expected "admin".`
      );
      process.exit(1);
    }
    const mainCount = await users.countDocuments({ isMainAdmin: true });
    if (mainCount > 0) {
      console.error(
        "Refusing to run: a Main Admin already exists. Use POST /api/admin/main-admin/transfer to hand ownership over."
      );
      process.exit(1);
    }
    const result = await users.updateOne(
      { _id: target._id, role: "admin", isMainAdmin: { $ne: true } },
      { $set: { isMainAdmin: true, updatedAt: new Date() } }
    );
    if (result.modifiedCount !== 1) {
      console.error("Failed to designate Main Admin (concurrent modification?). No changes made.");
      process.exit(1);
    }
    console.log(`Designated existing admin "${EMAIL}" as Main Admin.`);
    console.log("DONE. Remove ADMIN_BOOTSTRAP_DESIGNATE_MAIN from the environment.");
    await client.close();
    process.exit(0);
  }

  // --- Initial promotion (+ Main Admin designation if none exists) ---
  if (target.role === "admin") {
    const mainCount = await users.countDocuments({ isMainAdmin: true });
    if (mainCount === 0) {
      const result = await users.updateOne(
        { _id: target._id, role: "admin", isMainAdmin: { $ne: true } },
        { $set: { isMainAdmin: true, updatedAt: new Date() } }
      );
      if (result.modifiedCount !== 1) {
        console.error("Failed to designate Main Admin. No changes made.");
        process.exit(1);
      }
      console.log(`Designated existing admin "${EMAIL}" as Main Admin (no Main Admin existed).`);
      console.log("DONE. Remove ADMIN_BOOTSTRAP_* from the environment.");
      await client.close();
      process.exit(0);
    }
    console.error(`Refusing to run: user "${EMAIL}" is already an admin.`);
    process.exit(1);
  }
  if (target.role !== "customer") {
    console.error(
      `Refusing to run: user "${EMAIL}" has role "${target.role}", expected "customer".`
    );
    process.exit(1);
  }

  const result = await users.updateOne({ _id: target._id, role: "customer" }, {
    $set: { role: "admin", updatedAt: new Date() },
  });

  if (result.modifiedCount !== 1) {
    console.error("Failed to promote user (concurrent modification?). No changes made.");
    process.exit(1);
  }

  console.log(`Promoted existing user "${EMAIL}" to admin.`);

  // Designate Main Admin if none exists yet. Only the first designated
  // admin becomes Main Admin; later bootstrap runs promote normal admins
  // only (this path is for the initial hierarchy).
  const mainCount = await users.countDocuments({ isMainAdmin: true });

  if (mainCount === 0) {
    const designated = await users.updateOne(
      { _id: target._id, role: "admin", isMainAdmin: { $ne: true } },
      { $set: { isMainAdmin: true, updatedAt: new Date() } }
    );
    if (designated.modifiedCount !== 1) {
      // Promotion succeeded but designation must not silently fail.
      console.warn(
        "WARNING: promoted to admin, but designating Main Admin failed. Re-run with ADMIN_BOOTSTRAP_DESIGNATE_MAIN=true to designate."
      );
    } else {
      console.log(`Designated "${EMAIL}" as Main Admin (no Main Admin existed).`);
    }
  } else {
    console.log("A Main Admin is already designated — designation left unchanged.");
  }
  console.log(
    "DONE. Remove ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_CONFIRM from the environment, then restart the server."
  );
  await client.close();
  process.exit(0);
};

main().catch(async (error) => {
  console.error("Admin bootstrap failed:", error);
  try {
    await client.close();
  } catch {}
  process.exit(1);
});
