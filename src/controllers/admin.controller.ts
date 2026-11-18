import type { Response } from "express";
import { ObjectId, type Filter } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getDB, mongoClient } from "../config/db.js";
import { verifyPassword } from "better-auth/crypto";
import { getUsersCollection, type UserWithApplication } from "../models/technician-application.model.js";
import { getServicesCollection, type Service } from "../models/service.model.js";
import { getBookingsCollection, type Booking } from "../models/booking.model.js";
import {
  adminUsersQuerySchema,
  adminBookingsQuerySchema,
  adminServicesQuerySchema,
  updateUserRoleSchema,
  mainAdminTransferSchema,
  adminPaymentsQuerySchema,
  adminSearchFilter,
} from "../validators/admin.validator.js";
import {
  getPaymentsCollection,
  type Payment,
  type PaymentStatus,
} from "../models/payment.model.js";
import { toMinorUnits, fromMinorUnits } from "../utils/currency.js";

// Better Auth stores credential password hashes on the `account` collection
// (providerId "credential"). Read directly by the transfer re-auth path only;
// nothing outside the server ever sees these values.
const ACCOUNTS_COLLECTION = "account";

const OBJECT_ID_HEX_REGEX = /^[0-9a-fA-F]{24}$/;
const parseId = (raw: unknown): ObjectId | null =>
  typeof raw === "string" && OBJECT_ID_HEX_REGEX.test(raw) ? new ObjectId(raw) : null;

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));

const dateOrNull = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;
const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Safe admin payment DTO — no checkout URLs, no webhook signatures, no
 *  password hashes or other internal/account secrets. The Stripe Checkout
 *  Session id and payment intent id are identifiers, not secrets, and are
 *  useful for reconciliation; everything else is a plain field or null. */
const toAdminPaymentDto = (
  payment: Payment,
  customer: { name: string | null; email: string | null } | undefined
) => ({
  id: payment._id.toHexString(),
  bookingId: payment.bookingId.toHexString(),
  customerName: customer?.name ?? null,
  customerEmail: customer?.email ?? null,
  reference: stringOrNull(payment.stripeSessionId),
  paymentIntentId: stringOrNull(payment.stripePaymentIntentId),
  amount: fromMinorUnits(payment.amount, payment.currency),
  amountMinor: payment.amount,
  currency: payment.currency,
  status: payment.status,
  createdAt: payment.createdAt instanceof Date ? payment.createdAt.toISOString() : String(payment.createdAt),
  updatedAt: payment.updatedAt instanceof Date ? payment.updatedAt.toISOString() : String(payment.updatedAt),
  paidAt: dateOrNull(payment.paidAt),
});

/** Summary for the admin payments view. Aggregates the filtered dataset
 *  (identically scoped search/date, WITHOUT the status filter) straight in
 *  MongoDB — documents are never loaded into memory in bulk. Amounts are
 *  kept per currency: summing different currencies into one number would
 *  be meaningless. */
interface PaymentSummary {
  successfulPayments: number;
  successfulAmountByCurrency: Array<{ currency: string; amount: number }>;
  pendingPayments: number;
  failedPayments: number;
  expiredPayments: number;
}

const summarizePayments = async (
  filter: Filter<Payment>
): Promise<PaymentSummary> => {
  const [statusRows, amountRows] = await Promise.all([
    getPaymentsCollection()
      .aggregate<{ _id: PaymentStatus; count: number }>([
        { $match: filter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
      .toArray(),
    getPaymentsCollection()
      .aggregate<{ _id: string; total: number }>([
        { $match: { ...filter, status: "succeeded" as PaymentStatus } },
        { $group: { _id: "$currency", total: { $sum: "$amount" } } },
      ])
      .toArray(),
  ]);

  const byStatus = new Map(statusRows.map((row) => [row._id, row.count]));

  return {
    successfulPayments: byStatus.get("succeeded") ?? 0,
    successfulAmountByCurrency: amountRows.map((row) => ({
      currency: row._id,
      amount: fromMinorUnits(row.total, row._id),
    })),
    pendingPayments: byStatus.get("pending") ?? 0,
    failedPayments: byStatus.get("failed") ?? 0,
    expiredPayments: byStatus.get("expired") ?? 0,
  };
};

/** True Main Admin designation comes from the server-managed user document
 *  field `isMainAdmin` — never from the JWT, never from client input. */
const isMainAdmin = (user: UserWithApplication | null | undefined): boolean =>
  user?.isMainAdmin === true;

/** Safe admin user DTO — no password hashes, sessions, accounts, tokens or
 *  application subdocuments. */
const toUserDto = (user: UserWithApplication) => ({
  id: user._id.toHexString(),
  name: stringOrNull(user.name),
  email: stringOrNull(user.email),
  role: stringOrNull(user.role) ?? "customer",
  // Main Admin status is a public-ish flag needed to render the admin
  // hierarchy; it carries no secret.
  isMainAdmin: isMainAdmin(user),
  phone: stringOrNull(user.phone),
  area: stringOrNull(user.area),
  bio: stringOrNull(user.bio),
  createdAt: dateOrNull(user.createdAt),
  updatedAt: dateOrNull(user.updatedAt),
});

/** Safe admin booking DTO — business-relevant fields only; no internal
 *  ObjectId references or payment internals. */
const toBookingDto = (booking: Booking) => ({
  id: booking._id.toHexString(),
  customerName: booking.customerName,
  customerEmail: booking.customerEmail,
  technicianName: booking.technicianName,
  technicianEmail: booking.technicianEmail,
  serviceTitle: booking.serviceTitle,
  serviceCategory: booking.serviceCategory,
  serviceLocation: booking.serviceLocation,
  serviceImage: booking.serviceImage,
  hourlyRate: booking.hourlyRate,
  securityDeposit: booking.securityDeposit,
  problemDescription: booking.problemDescription,
  status: booking.status,
  paymentStatus: booking.paymentStatus,
  finalAmount: booking.finalAmount ?? null,
  createdAt: booking.createdAt instanceof Date ? booking.createdAt.toISOString() : String(booking.createdAt),
  updatedAt: booking.updatedAt instanceof Date ? booking.updatedAt.toISOString() : String(booking.updatedAt),
});

// GET /api/admin/dashboard/stats — aggregated platform counters.
// Payment stats are not wired to the payments collection yet; the amount
// is reported as 0 with an availability flag rather than fabricated.
export const getDashboardStats = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const users = getUsersCollection();
  const services = getServicesCollection();
  const bookings = getBookingsCollection();

  const [
    totalUsers,
    totalCustomers,
    totalTechnicians,
    totalServices,
    pendingServiceApprovals,
    approvedServices,
    totalBookings,
    requestedBookings,
    inProgressBookings,
    completedBookings,
    cancelledBookings,
    pendingTechnicianApplications,
  ] = await Promise.all([
    users.countDocuments({}),
    users.countDocuments({ role: "customer" }),
    users.countDocuments({ role: "technician" }),
    services.countDocuments({}),
    services.countDocuments({ approvalStatus: "pending" }),
    services.countDocuments({ approvalStatus: "approved" }),
    bookings.countDocuments({}),
    bookings.countDocuments({ status: "requested" }),
    bookings.countDocuments({ status: "in-progress" }),
    bookings.countDocuments({ status: "completed" }),
    bookings.countDocuments({ status: "cancelled" }),
    users.countDocuments({ "technicianApplication.status": "pending" }),
  ]);

  const paymentsCollection = await getDB()
    .listCollections({ name: "payments" }, { nameOnly: true })
    .next();

  res.status(200).json({
    success: true,
    data: {
      totalUsers,
      totalCustomers,
      totalTechnicians,
      totalServices,
      pendingServiceApprovals,
      approvedServices,
      totalBookings,
      requestedBookings,
      inProgressBookings,
      completedBookings,
      cancelledBookings,
      pendingTechnicianApplications,
      // Payment totals are not wired to the payments collection yet.
      totalSuccessfulPaymentAmount: 0,
      paymentsAvailable: Boolean(paymentsCollection),
      paymentNote: paymentsCollection
        ? "Payment records exist but no verified successful-payment schema is defined yet."
        : "Payments are not implemented yet; no verified payment records exist.",
    },
  });
};

// GET /api/admin/users — paginated, searchable, safe DTOs.
export const listUsers = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const parsed = adminUsersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed.", errors: issues(parsed.error) });
    return;
  }
  const { role } = parsed.data;
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 12;
  const pattern = adminSearchFilter(parsed.data.search);

  const filter = {
    ...(role ? { role } : {}),
    ...(pattern
      ? {
          $or: [
            { name: { $regex: pattern, $options: "i" as const } },
            { email: { $regex: pattern, $options: "i" as const } },
          ],
        }
      : {}),
  };

  const [items, totalItems] = await Promise.all([
    getUsersCollection()
      .find(filter, {
        projection: {
          name: 1, email: 1, role: 1, isMainAdmin: 1, phone: 1, area: 1, bio: 1, createdAt: 1, updatedAt: 1,
        },
      })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getUsersCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  res.status(200).json({
    success: true,
    data: items.map(toUserDto),
    pagination: { currentPage: page, limit, totalItems, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
  });
};

// GET /api/admin/users/:id — safe details for one user.
export const getUserById = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ success: false, message: "Invalid user id." });
    return;
  }
  const user = await getUsersCollection().findOne(
    { _id: id },
    { projection: { name: 1, email: 1, role: 1, isMainAdmin: 1, phone: 1, area: 1, bio: 1, createdAt: 1, updatedAt: 1 } }
  );
  if (!user) {
    res.status(404).json({ success: false, message: "User not found." });
    return;
  }
  res.status(200).json({ success: true, data: toUserDto(user) });
};

// Domain errors raised inside the admin-demotion transaction. The update
// aborts; each reason maps to a safe HTTP response without leaking internals.
class AdminDemotionError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "AdminDemotionError";
    this.reason = reason;
  }
}

const mapAdminDemotionError = (
  reason: string
): { status: number; message: string } => {
  switch (reason) {
    case "actor-not-main":
      return { status: 403, message: "Only the Main Admin can demote an admin." };
    case "target-is-main":
      return { status: 409, message: "The Main Admin cannot be demoted or modified." };
    default:
      // target-changed / target-missing — keep responses indistinguishable.
      return { status: 409, message: "User role changed concurrently. Refresh and try again." };
  }
};

// Demotes an admin inside a MongoDB transaction. Every check is re-read
// inside the transaction: the actor must still hold the Main Admin
// designation, the target must still be an admin and must not be the Main
// Admin. No non-atomic fallback — without transaction support the demotion
// cannot proceed.
const demoteAdminAtomically = async (
  res: Response,
  adminId: ObjectId,
  targetId: ObjectId,
  nextRole: "customer" | "technician"
): Promise<void> => {
  const users = getUsersCollection();
  const session = mongoClient.startSession();

  try {
    await session.withTransaction(async () => {
      // NOTE: MongoDB allows exactly one operation per transaction session
      // at a time — all commands run sequentially.
      const freshActor = await users.findOne(
        { _id: adminId },
        { projection: { isMainAdmin: 1 }, session }
      );

      if (!freshActor || freshActor.isMainAdmin !== true) {
        throw new AdminDemotionError("actor-not-main");
      }

      const freshTarget = await users.findOne(
        { _id: targetId },
        { projection: { role: 1, isMainAdmin: 1, technicianApplication: 1 }, session }
      );

      if (!freshTarget || freshTarget.role !== "admin") {
        throw new AdminDemotionError("target-changed");
      }

      if (freshTarget.isMainAdmin === true) {
        throw new AdminDemotionError("target-is-main");
      }

      const updated = await users.findOneAndUpdate(
        { _id: targetId, role: "admin" },
        { $set: { role: nextRole, updatedAt: new Date() } },
        { returnDocument: "after", session }
      );

      if (!updated) {
        throw new AdminDemotionError("target-changed");
      }

      res.status(200).json({
        success: true,
        message: `Role updated to ${nextRole}.`,
        data: toUserDto(updated),
      });
    });
  } catch (error) {
    if (error instanceof AdminDemotionError) {
      const mapped = mapAdminDemotionError(error.reason);
      res.status(mapped.status).json({ success: false, message: mapped.message });
      return;
    }

    if (isTransactionUnsupportedError(error)) {
      console.error("Admin demotion aborted: transactions unsupported by this MongoDB deployment.");
      res.status(503).json({
        success: false,
        message: "Admin demotion is not supported in this environment.",
      });
      return;
    }

    // The transaction aborted unexpectedly; the handler's error propagates
    // to Express 5's errorHandler, same shape as any other 500.
    throw error;
  } finally {
    await session.endSession();
  }
};

// PATCH /api/admin/users/:id/role — tightly constrained role changes.
// Main Admin hierarchy rules:
// - an admin may promote an existing customer/technician to admin (never
//   creating accounts, never touching passwords; promotion never grants
//   Main Admin designation);
// - only the Main Admin may demote an admin (Normal Admins receive 403);
// - the Main Admin cannot be demoted or modified by anyone, including the
//   Main Admin — self-changes are rejected above, so no other admin can
//   ever reach this point targeting the Main Admin;
// - an admin cannot change their own role (self-promotion/demotion);
// - customer -> technician requires an approved application;
// - admin demotions run inside a MongoDB transaction so the caller must
//   still hold the Main Admin designation when the write lands (the same
//   guarantee as the transfer endpoint); there is no non-atomic fallback.
// - updates are atomic and guarded by the current role.
export const updateUserRole = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  const targetId = parseId(req.params.id);
  if (!targetId) {
    res.status(400).json({ success: false, message: "Invalid user id." });
    return;
  }
  const adminId = parseId(req.user.id);
  if (!adminId) {
    res.status(401).json({ success: false, message: "Invalid token payload." });
    return;
  }

  const parsed = updateUserRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed.", errors: issues(parsed.error) });
    return;
  }
  const nextRole = parsed.data.role;

  if (targetId.equals(adminId)) {
    res.status(403).json({ success: false, message: "You cannot change your own role." });
    return;
  }

  const target = await getUsersCollection().findOne(
    { _id: targetId },
    { projection: { role: 1, isMainAdmin: 1, technicianApplication: 1 } }
  );
  if (!target) {
    res.status(404).json({ success: false, message: "User not found." });
    return;
  }
  const currentRole = stringOrNull(target.role) ?? "customer";

  if (currentRole === nextRole) {
    res.status(409).json({ success: false, message: `User is already a ${nextRole}.` });
    return;
  }

  // Technician promotions: only a customer can be promoted to technician,
  // and only with an approved application. Other current roles fall through
  // (technician -> technician is a 409 above; admin -> technician is an
  // admin demotion, handled by the hierarchy rules below).
  if (nextRole === "technician" && currentRole === "customer") {
    if (target.technicianApplication?.status !== "approved") {
      res.status(409).json({
        success: false,
        message: "This customer has no approved technician application.",
      });
      return;
    }
  }

  // Admin demotion rules. Active inside a transaction (see
  // demoteAdminAtomically) so the caller must still hold the Main Admin
  // designation when the write commits — a racing ownership transfer cannot
  // grant demotion rights to a normal admin mid-flight.
  if (currentRole === "admin" && nextRole !== "admin") {
    return demoteAdminAtomically(res, adminId, targetId, nextRole);
  }

  const updated = await getUsersCollection().findOneAndUpdate(
    { _id: targetId, role: currentRole },
    { $set: { role: nextRole, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    res.status(409).json({ success: false, message: "User role changed concurrently. Refresh and try again." });
    return;
  }

  res.status(200).json({
    success: true,
    message: `Role updated to ${nextRole}.`,
    data: toUserDto(updated),
  });
};

// Domain errors raised inside the transfer transaction. The update aborts;
// each reason maps to a safe HTTP response. No internal state leaks.
class AdminTransferError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "AdminTransferError";
    this.reason = reason;
  }
}

// MongoDB reports missing multi-document transaction support with
// code 20 (IllegalOperation) or a message about transactions/replica sets.
// There is deliberately NO non-atomic two-write fallback: without a
// transaction the transfer simply cannot proceed.
const isTransactionUnsupportedError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? "");
  return code === 20 || /transaction.*(not supported|replica set|mongos)|transaction numbers/i.test(message);
};

const mapTransferError = (
  reason: string
): { status: number; message: string } => {
  switch (reason) {
    case "actor-not-main":
      return { status: 403, message: "Only the Main Admin can transfer ownership." };
    case "target-not-admin":
      return { status: 409, message: "Main Admin ownership can only be transferred to an existing Admin." };
    case "target-already-main":
      return { status: 409, message: "Target already holds Main Admin ownership." };
    case "actor-changed":
    case "target-changed":
      return { status: 409, message: "The account changed concurrently with the transfer. Refresh and try again." };
    default:
      // main-count-N / post-count-N — should be impossible; fail visibly.
      return { status: 409, message: "Main Admin designation is inconsistent. Please contact support." };
  }
};

// POST /api/admin/main-admin/transfer — Main Admin hands ownership to another
// existing Normal Admin. Requires the current Main Admin's password for
// re-authentication. The swap happens inside a MongoDB transaction; there is
// no non-atomic fallback, so the platform can never end up with zero or
// multiple Main Admins. Both accounts keep the admin role; only the
// isMainAdmin designation moves. Exactly one Main Admin remains.
export const transferMainAdmin = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const actorId = parseId(req.user.id);

  if (!actorId) {
    res.status(401).json({ success: false, message: "Invalid token payload." });
    return;
  }

  const parsed = mainAdminTransferSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: issues(parsed.error),
    });
    return;
  }

  const targetId = new ObjectId(parsed.data.targetUserId);
  const users = getUsersCollection();

  // Actors are resolved fresh from the database — Main Admin designation
  // never comes from the JWT.
  const actor = await users.findOne(
    { _id: actorId },
    { projection: { role: 1, isMainAdmin: 1 } }
  );

  if (!actor || actor.role !== "admin") {
    res.status(403).json({ success: false, message: "Admin access only." });
    return;
  }

  if (!isMainAdmin(actor)) {
    res.status(403).json({ success: false, message: "Only the Main Admin can transfer ownership." });
    return;
  }

  if (targetId.equals(actorId)) {
    res.status(400).json({ success: false, message: "You cannot transfer Main Admin ownership to yourself." });
    return;
  }

  const target = await users.findOne(
    { _id: targetId },
    { projection: { role: 1, isMainAdmin: 1 } }
  );

  if (!target) {
    res.status(404).json({ success: false, message: "Target user not found." });
    return;
  }

  if (target.role !== "admin") {
    res.status(409).json({ success: false, message: "Main Admin ownership can only be transferred to an existing Admin." });
    return;
  }

  if (isMainAdmin(target)) {
    res.status(409).json({ success: false, message: "Target already holds Main Admin ownership." });
    return;
  }

  // Re-authentication: verify the current Main Admin's password against
  // Better Auth's credential account. The password is compared in memory
  // and never stored, logged or returned.
  const account = await getDB()
    .collection(ACCOUNTS_COLLECTION)
    .findOne({ userId: actorId, providerId: "credential" });

  const storedHash = account && typeof account.password === "string" ? account.password : null;

  if (!storedHash) {
    res.status(401).json({ success: false, message: "Re-authentication failed. Check your password and try again." });
    return;
  }

  const passwordOk = await verifyPassword({ hash: storedHash, password: parsed.data.password });

  if (!passwordOk) {
    res.status(401).json({ success: false, message: "Re-authentication failed. Check your password and try again." });
    return;
  }

  // Multi-document swap: clear the actor's designation, set the target's.
  // All checks are re-read inside the transaction to close the TOCTOU race,
  // and the post-condition count invariant (exactly one Main Admin) is
  // asserted before commit. No audit collection is introduced; the log line
  // records only the involved ids.
  const session = mongoClient.startSession();

  try {
    await session.withTransaction(async () => {
      // NOTE: MongoDB allows exactly one operation per transaction session at
      // a time — concurrent operations on one session are rejected with
      // "Only servers in a sharded cluster can start a new transaction".
      // All commands inside this transaction run sequentially.
      const freshActor = await users.findOne(
        { _id: actorId },
        { projection: { isMainAdmin: 1 }, session }
      );

      const freshTarget = await users.findOne(
        { _id: targetId },
        { projection: { isMainAdmin: 1, role: 1 }, session }
      );

      if (!isMainAdmin(freshActor)) {
        throw new AdminTransferError("actor-not-main");
      }

      if (!freshTarget || freshTarget.role !== "admin") {
        throw new AdminTransferError("target-not-admin");
      }

      if (isMainAdmin(freshTarget)) {
        throw new AdminTransferError("target-already-main");
      }

      const existingMainAdmins = await users.countDocuments({ isMainAdmin: true }, { session });

      if (existingMainAdmins !== 1) {
        throw new AdminTransferError(`main-count-${existingMainAdmins}`);
      }

      const now = new Date();

      const cleared = await users.findOneAndUpdate(
        { _id: actorId, isMainAdmin: true },
        { $unset: { isMainAdmin: "" }, $set: { updatedAt: now } },
        { returnDocument: "after", session }
      );

      if (!cleared) {
        throw new AdminTransferError("actor-changed");
      }

      const designated = await users.findOneAndUpdate(
        { _id: targetId, role: "admin", isMainAdmin: { $ne: true } },
        { $set: { isMainAdmin: true, updatedAt: now } },
        { returnDocument: "after", session }
      );

      if (!designated) {
        throw new AdminTransferError("target-changed");
      }

      const remainingMainAdmins = await users.countDocuments({ isMainAdmin: true }, { session });

      if (remainingMainAdmins !== 1) {
        throw new AdminTransferError(`post-count-${remainingMainAdmins}`);
      }
    });
  } catch (error) {
    if (error instanceof AdminTransferError) {
      const mapped = mapTransferError(error.reason);
      res.status(mapped.status).json({ success: false, message: mapped.message });
      return;
    }

    if (isTransactionUnsupportedError(error)) {
      console.error("Main Admin transfer aborted: transactions unsupported by this MongoDB deployment.");
      res.status(503).json({
        success: false,
        message: "Main Admin transfer is not supported in this environment.",
      });
      return;
    }

    console.error(
      "Main Admin transfer failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    res.status(500).json({
      success: false,
      message: "Couldn't transfer Main Admin ownership right now. Please try again.",
    });
    return;
  } finally {
    await session.endSession();
  }

  console.log(`[admin] Main Admin ownership transferred from ${actorId.toHexString()} to ${targetId.toHexString()}`);

  res.status(200).json({
    success: true,
    message: "Main Admin ownership transferred.",
    data: {
      previousMainAdminId: actorId.toHexString(),
      newMainAdminId: targetId.toHexString(),
    },
  });
};

// GET /api/admin/bookings — all bookings, filters, pagination, safe DTOs.
// Read-only: no status mutation is possible through this endpoint.
export const listAllBookings = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const parsed = adminBookingsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed.", errors: issues(parsed.error) });
    return;
  }
  const { status, paymentStatus } = parsed.data;
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 12;
  const pattern = adminSearchFilter(parsed.data.search);

  const filter: Filter<Booking> = {
    // Cancelled bookings are permanently retained but excluded from the
    // default list; pass ?status=cancelled to see only cancelled records.
    ...(status ? { status } : { status: { $ne: "cancelled" } }),
    ...(paymentStatus ? { paymentStatus } : {}),
    ...(pattern
      ? {
          $or: [
            { customerName: { $regex: pattern, $options: "i" as const } },
            { customerEmail: { $regex: pattern, $options: "i" as const } },
            { serviceTitle: { $regex: pattern, $options: "i" as const } },
            { technicianName: { $regex: pattern, $options: "i" as const } },
          ],
        }
      : {}),
  };

  const [items, totalItems] = await Promise.all([
    getBookingsCollection()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getBookingsCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  res.status(200).json({
    success: true,
    data: items.map(toBookingDto),
    pagination: { currentPage: page, limit, totalItems, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
  });
};

/** Safe admin service DTO — all technician-editable business fields plus
 *  public technician identity (needed for moderation), without internal
 *  ObjectId references or account secrets. */
const toAdminServiceDto = (service: Service) => ({
  id: service._id.toHexString(),
  title: service.title,
  category: service.category,
  description: service.description,
  overview: service.overview,
  hourlyRate: service.hourlyRate,
  securityDeposit: service.securityDeposit,
  maxCapacity: service.maxCapacity,
  location: service.location,
  image: service.image,
  amenities: service.amenities ?? [],
  approvalStatus: service.approvalStatus,
  availabilityStatus: service.availabilityStatus,
  rejectionReason: service.rejectionReason ?? null,
  technicianName: service.technicianName,
  technicianEmail: service.technicianEmail,
  createdAt: service.createdAt instanceof Date ? service.createdAt.toISOString() : String(service.createdAt),
  updatedAt: service.updatedAt instanceof Date ? service.updatedAt.toISOString() : String(service.updatedAt),
});

// GET /api/admin/services — admin-only moderation listing, newest first.
// Defaults to pending services. /api/services/my cannot serve this purpose:
// it is technician-only and scoped to the caller's own documents.
export const listServicesForAdmin = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const parsed = adminServicesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed.", errors: issues(parsed.error) });
    return;
  }
  const { status, search } = parsed.data;
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 12;
  const pattern = adminSearchFilter(search);

  const filter = {
    approvalStatus: status,
    ...(pattern
      ? {
          $or: [
            { title: { $regex: pattern, $options: "i" as const } },
            { category: { $regex: pattern, $options: "i" as const } },
            { location: { $regex: pattern, $options: "i" as const } },
            { technicianName: { $regex: pattern, $options: "i" as const } },
          ],
        }
      : {}),
  };

  const [items, totalItems] = await Promise.all([
    getServicesCollection()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getServicesCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  res.status(200).json({
    success: true,
    data: items.map(toAdminServiceDto),
    pagination: { currentPage: page, limit, totalItems, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
  });
};

// GET /api/admin/payments — paginated Stripe checkout payments across all
// customers, newest first. Read-only by design: the only authority on a
// payment's status is the verified Stripe webhook. Admin-only via
// verifyToken -> verifyAdmin at the route layer.
export const listPaymentsForAdmin = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const parsed = adminPaymentsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: "Validation failed.", errors: issues(parsed.error) });
    return;
  }

  const { status, from, to, search } = parsed.data;
  const page = parsed.data.page ?? 1;
  // Chosen behaviour (consistent with other admin lists): limit above 50 is rejected with 400.
  const limit = parsed.data.limit ?? 12;

  const filter: Filter<Payment> = {};

  if (status) {
    filter.status = status;
  }

  if (from) {
    filter.createdAt = { $gte: new Date(`${from}T00:00:00.000Z`) };
  }
  if (to) {
    filter.createdAt = { ...(filter.createdAt ?? {}), $lte: new Date(`${to}T23:59:59.999Z`) };
  }

  const pattern = adminSearchFilter(search);

  if (pattern && typeof search === "string") {
    const trimmed = search.trim();
    const hexId = OBJECT_ID_HEX_REGEX.test(trimmed) ? new ObjectId(trimmed) : null;
    const userMatches = await getUsersCollection()
      .find(
        {
          $or: [
            { name: { $regex: pattern, $options: "i" } },
            { email: { $regex: pattern, $options: "i" } },
          ],
        },
        { projection: { _id: 1 } }
      )
      .toArray();

    const orConditions: Filter<Payment>[] = [
      { stripeSessionId: { $regex: pattern, $options: "i" } },
      { stripePaymentIntentId: { $regex: pattern, $options: "i" } },
    ];

    if (userMatches.length > 0) {
      orConditions.push({ customerId: { $in: userMatches.map((user) => user._id) } });
    }

    if (hexId) {
      orConditions.push({ _id: hexId });
      orConditions.push({ bookingId: hexId });
    }

    filter.$or = orConditions;
  }

  // Summary is computed on the same search/date scope but deliberately
  // ignores the status filter so the cards stay meaningful while drilling.
  const summaryFilter: Filter<Payment> = { ...filter };
  delete summaryFilter.status;

  const [items, totalItems, summary] = await Promise.all([
    getPaymentsCollection()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getPaymentsCollection().countDocuments(filter),
    summarizePayments(summaryFilter),
  ]);

  const customerIds = [
    ...new Set(items.map((payment) => payment.customerId.toHexString())),
  ].map((id) => new ObjectId(id));
  const customers = customerIds.length
    ? await getUsersCollection()
        .find({ _id: { $in: customerIds } }, { projection: { name: 1, email: 1 } })
        .toArray()
    : [];
  const customerMap = new Map(
    customers.map((customer) => [
      customer._id.toHexString(),
      {
        name: stringOrNull(customer.name),
        email: stringOrNull(customer.email),
      },
    ])
  );

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  res.status(200).json({
    success: true,
    data: items.map((payment) =>
      toAdminPaymentDto(payment, customerMap.get(payment.customerId.toHexString()))
    ),
    summary,
    pagination: { currentPage: page, limit, totalItems, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
  });
};
