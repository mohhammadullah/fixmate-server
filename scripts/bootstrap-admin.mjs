/**
 * One-time, server-side admin bootstrap (development / deployment utility).
 *
 * Promotes an EXISTING Better Auth user (by exact email) to the admin role.
 * It never creates users, never accepts a password, and is never exposed
 * through an HTTP endpoint. Public signup always assigns "customer".
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
  if (target.role === "admin") {
    console.error(`Refusing to run: user "${EMAIL}" is already an admin (bootstrap is one-time).`);
    process.exit(1);
  }
  if (target.role !== "customer") {
    console.error(
      `Refusing to run: user "${EMAIL}" has role "${target.role}", expected "customer".`
    );
    process.exit(1);
  }

  const result = await users.updateOne({ _id: target._id, role: "customer" }, {
    $set: { role: "admin" },
  });

  if (result.modifiedCount !== 1) {
    console.error("Failed to promote user (concurrent modification?). No changes made.");
    process.exit(1);
  }

  console.log(`Promoted existing user "${EMAIL}" to admin.`);
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
