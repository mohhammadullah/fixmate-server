import type { Response } from "express";
import { ObjectId } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getDB } from "../config/db.js";
import { getUsersCollection, type UserWithApplication } from "../models/technician-application.model.js";
import { getServicesCollection, type Service } from "../models/service.model.js";
import { getBookingsCollection, type Booking } from "../models/booking.model.js";
import {
  adminUsersQuerySchema,
  adminBookingsQuerySchema,
  adminServicesQuerySchema,
  updateUserRoleSchema,
  adminSearchFilter,
} from "../validators/admin.validator.js";

const OBJECT_ID_HEX_REGEX = /^[0-9a-fA-F]{24}$/;
const parseId = (raw: unknown): ObjectId | null =>
  typeof raw === "string" && OBJECT_ID_HEX_REGEX.test(raw) ? new ObjectId(raw) : null;

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));

const dateOrNull = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;
const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Safe admin user DTO — no password hashes, sessions, accounts, tokens or
 *  application subdocuments. */
const toUserDto = (user: UserWithApplication) => ({
  id: user._id.toHexString(),
  name: stringOrNull(user.name),
  email: stringOrNull(user.email),
  role: stringOrNull(user.role) ?? "customer",
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
// Payments: no payments collection/model or verified payment records exist
// in the current schema, so the amount is honestly reported as 0 with an
// availability flag — never fabricated.
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
      // No verified payment records exist in the current schema.
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
          name: 1, email: 1, role: 1, phone: 1, area: 1, bio: 1, createdAt: 1, updatedAt: 1,
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
    { projection: { name: 1, email: 1, role: 1, phone: 1, area: 1, bio: 1, createdAt: 1, updatedAt: 1 } }
  );
  if (!user) {
    res.status(404).json({ success: false, message: "User not found." });
    return;
  }
  res.status(200).json({ success: true, data: toUserDto(user) });
};

// PATCH /api/admin/users/:id/role — tightly constrained role changes.
// Security rules:
// - admin is never assignable here (bootstrap script is the only path);
// - an admin cannot demote themselves;
// - the last remaining admin cannot be demoted;
// - customer -> technician requires an approved application;
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
    { projection: { role: 1, technicianApplication: 1 } }
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

  if (currentRole === "admin") {
    const adminCount = await getUsersCollection().countDocuments({ role: "admin" });
    if (adminCount <= 1) {
      res.status(409).json({ success: false, message: "Cannot demote the last remaining admin." });
      return;
    }
  }

  if (nextRole === "technician") {
    if (currentRole !== "customer") {
      res.status(409).json({
        success: false,
        message: "Only customers with an approved technician application can become technicians.",
      });
      return;
    }
    if (target.technicianApplication?.status !== "approved") {
      res.status(409).json({
        success: false,
        message: "This customer has no approved technician application.",
      });
      return;
    }
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

  const filter = {
    ...(status ? { status } : {}),
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
