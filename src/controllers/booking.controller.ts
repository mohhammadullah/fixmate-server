
import type { Response } from "express";
import { ObjectId, type Filter, type Sort } from "mongodb";
import { getDB } from "../config/db.js";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { createBookingSchema, listTechnicianBookingsQuerySchema, updateBookingStatusSchema, OBJECT_ID_HEX_REGEX } from "../validators/booking.validator.js";
import {
  getBookingsCollection,
  ACTIVE_BOOKING_STATUSES,
  type Booking,
} from "../models/booking.model.js";
import { getServicesCollection } from "../models/service.model.js";

// Better Auth's MongoDB adapter stores users in the singular `user`
// collection with `_id` as an ObjectId; the JWT's `id` claim is the
// ObjectId hex string.
const USERS_COLLECTION = "user";

interface AuthUserDocument {
  _id: ObjectId;
  name?: unknown;
  email?: unknown;
  role?: unknown;
}

// MongoDB duplicate-key error (unique index violation), matched by code so
// it works regardless of which unique index was violated and without
// `instanceof` across driver builds.
const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

const DUPLICATE_BOOKING_MESSAGE =
  "You already have an active booking for this service.";

// Strict 24-character hexadecimal ObjectId for route params (mirrors the
// admin service endpoints): ObjectId.isValid would also accept 12-byte
// strings, so check explicitly.
const parseParamId = (raw: unknown): ObjectId | null => {
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (typeof id !== "string" || !OBJECT_ID_HEX_REGEX.test(id)) {
    return null;
  }

  return new ObjectId(id);
};

// Technician identity comes exclusively from the verified JWT; a missing
// JWT payload is rejected here as defense-in-depth (the route middleware
// already enforces it).
const resolveTechnicianId = (
  req: AuthenticatedRequest
): ObjectId | null => {
  if (!req.user || !ObjectId.isValid(req.user.id)) {
    return null;
  }
  return new ObjectId(req.user.id);
};

const TECHNICIAN_SORT: Sort = { createdAt: -1, _id: -1 };

// POST /api/bookings — customer only (verifyToken -> verifyCustomer).
// Identity is taken exclusively from the verified JWT and the server-side
// user document; client-supplied ownership/status/payment fields are
// rejected by the strict validator.
export const createBooking = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  if (!ObjectId.isValid(authUser.id)) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const parsed = createBookingSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const customerId = new ObjectId(authUser.id);
  const serviceId = new ObjectId(parsed.data.serviceId);

  // Customer identity comes from verified JWT + server-side user document,
  // never from the request body.
  const dbUser = await getDB()
    .collection<AuthUserDocument>(USERS_COLLECTION)
    .findOne({ _id: customerId });

  if (!dbUser) {
    res.status(404).json({
      success: false,
      message: "Customer account not found.",
    });
    return;
  }

  const customerName =
    typeof dbUser.name === "string" && dbUser.name.trim().length > 0
      ? dbUser.name.trim()
      : undefined;
  const customerEmail =
    typeof dbUser.email === "string" && dbUser.email.trim().length > 0
      ? dbUser.email.trim()
      : undefined;

  if (!customerName || !customerEmail) {
    res.status(500).json({
      success: false,
      message: "Unable to load customer profile.",
    });
    return;
  }

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const service = await getServicesCollection().findOne({ _id: serviceId });

  if (!service) {
    res.status(404).json({
      success: false,
      message: "Service not found.",
    });
    return;
  }

  if (
    service.approvalStatus !== "approved" ||
    service.availabilityStatus !== "available"
  ) {
    res.status(409).json({
      success: false,
      message: "Service is not available for booking.",
    });
    return;
  }

  if (service.technicianId.equals(customerId)) {
    res.status(403).json({
      success: false,
      message: "You cannot book your own service.",
    });
    return;
  }

  // Friendly pre-check for a clear message. The authoritative guard
  // against concurrent duplicate bookings is the unique partial index
  // `bookings_active_customer_service_unique` on the bookings collection
  // (status IN requested/accepted/in-progress); a violation surfaces as
  // duplicate-key error 11000 and is translated to 409 below.
  const duplicate = await getBookingsCollection().findOne(
    {
      customerId,
      serviceId,
      status: { $in: [...ACTIVE_BOOKING_STATUSES] },
    },
    { projection: { _id: 1 } }
  );

  if (duplicate) {
    res.status(409).json({
      success: false,
      message: DUPLICATE_BOOKING_MESSAGE,
    });
    return;
  }

  const now = new Date();

  const booking: Booking = {
    _id: new ObjectId(),
    serviceId: service._id,
    customerId,
    technicianId: service.technicianId,
    customerName,
    customerEmail,
    technicianName: service.technicianName,
    technicianEmail: service.technicianEmail,
    serviceTitle: service.title,
    serviceCategory: service.category,
    serviceLocation: service.location,
    serviceImage: service.image,
    hourlyRate: service.hourlyRate,
    securityDeposit: service.securityDeposit,
    problemDescription: parsed.data.problemDescription,
    status: "requested",
    paymentStatus: "unpaid",
    createdAt: now,
    updatedAt: now,
  };

  try {
    await getBookingsCollection().insertOne(booking);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({
        success: false,
        message: DUPLICATE_BOOKING_MESSAGE,
      });
      return;
    }
    throw error;
  }

  res.status(201).json({
    success: true,
    message: "Booking created successfully.",
    data: booking,
  });
};

// GET /api/bookings/technician — technician only (verifyToken -> verifyTechnician).
// Returns only bookings whose technicianId matches the verified JWT; any
// technicianId in the query string is stripped by the schema and ignored.
export const listTechnicianBookings = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const technicianId = resolveTechnicianId(req);

  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  if (!technicianId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const parsed = listTechnicianBookingsQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const { status } = parsed.data;
  const page = parsed.data.page ?? 1;
  // Chosen behavior: limit above 50 is rejected by the schema with 400.
  const limit = parsed.data.limit ?? 12;

  const filter: Filter<Booking> = { technicianId };

  if (status) {
    filter.status = status;
  }

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const [items, totalItems] = await Promise.all([
    getBookingsCollection()
      .find(filter)
      .sort(TECHNICIAN_SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getBookingsCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

  res.status(200).json({
    success: true,
    data: items,
    pagination: {
      currentPage: page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  });
};

// Shared tail for the accept/reject transition helpers: after an atomic
// update fails to match, distinguish "booking not found / not owned by this
// technician" (404) from "owned but not in the requested state" (409). The
// lookup is scoped to {_id, technicianId} so another technician's booking
// is indistinguishable from a missing one.
const respondAfterFailedTransition = async (
  res: Response,
  bookingId: ObjectId,
  technicianId: ObjectId
): Promise<void> => {
  const existing = await getBookingsCollection().findOne(
    { _id: bookingId, technicianId },
    { projection: { _id: 1 } }
  );

  if (!existing) {
    res.status(404).json({
      success: false,
      message: "Booking not found.",
    });
    return;
  }

  res.status(409).json({
    success: false,
    message: "Booking is not in a state that allows this action.",
  });
};

// Shared implementation for PATCH /:id/accept and /:id/reject. The atomic
// {_id, technicianId, status: "requested"} filter is the only guard for
// the transition; the second lookup runs only after a failed update and
// never authorizes a write.
const transitionRequestedBooking = async (
  req: AuthenticatedRequest,
  res: Response,
  targetStatus: "accepted" | "rejected",
  successMessage: string
): Promise<void> => {
  const technicianId = resolveTechnicianId(req);

  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  if (!technicianId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const { id } = req.params;
  const bookingId = parseParamId(id);

  if (!bookingId) {
    res.status(400).json({
      success: false,
      message: "Invalid booking id.",
    });
    return;
  }

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const updated = await getBookingsCollection().findOneAndUpdate(
    { _id: bookingId, technicianId, status: "requested" },
    { $set: { status: targetStatus, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!updated) {
    await respondAfterFailedTransition(res, bookingId, technicianId);
    return;
  }

  res.status(200).json({
    success: true,
    message: successMessage,
    data: updated,
  });
};

// PATCH /api/bookings/:id/accept — technician only (verifyToken -> verifyTechnician).
// Accepts a booking assigned to the authenticated technician; only bookings
// still in "requested" may be accepted.
export const acceptBooking = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  await transitionRequestedBooking(
    req,
    res,
    "accepted",
    "Booking accepted successfully."
  );
};

// PATCH /api/bookings/:id/reject — technician only (verifyToken -> verifyTechnician).
// Rejects a booking assigned to the authenticated technician; only bookings
// still in "requested" may be rejected. No rejection reason is required by
// the assignment.
export const rejectBooking = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  await transitionRequestedBooking(
    req,
    res,
    "rejected",
    "Booking rejected successfully."
  );
};

// Maps the target status to the expected source status. Only these two
// forward transitions exist; everything else is a 409.
const STATUS_TRANSITIONS = {
  "in-progress": { from: "accepted", message: "Booking marked as in-progress." },
  completed: { from: "in-progress", message: "Booking completed successfully." },
} as const;

// PATCH /api/bookings/:id/status — technician only (verifyToken -> verifyTechnician).
// Moves an accepted booking to in-progress, or an in-progress booking to
// completed (with finalAmount). finalAmount is the technician's final repair
// charge at this stage — it is not a payment and triggers no payment flow.
// Ownership and the expected source status are enforced atomically by the
// {_id, technicianId, status: <from>} filter; the post-failure lookup only
// distinguishes 404 from 409 and never authorizes a write.
export const updateBookingStatus = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  const technicianId = resolveTechnicianId(req);

  if (!technicianId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const { id } = req.params;
  const bookingId = parseParamId(id);

  if (!bookingId) {
    res.status(400).json({
      success: false,
      message: "Invalid booking id.",
    });
    return;
  }

  const parsed = updateBookingStatusSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const transition = STATUS_TRANSITIONS[parsed.data.status];

  const updatePayload: Partial<Pick<Booking, "status" | "finalAmount" | "updatedAt">> = {
    status: parsed.data.status,
    updatedAt: new Date(),
  };

  if (parsed.data.status === "completed") {
    updatePayload.finalAmount = parsed.data.finalAmount;
  }

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const updated = await getBookingsCollection().findOneAndUpdate(
    { _id: bookingId, technicianId, status: transition.from },
    { $set: updatePayload },
    { returnDocument: "after" }
  );

  if (!updated) {
    await respondAfterFailedTransition(res, bookingId, technicianId);
    return;
  }

  res.status(200).json({
    success: true,
    message: transition.message,
    data: updated,
  });
};
