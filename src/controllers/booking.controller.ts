
import type { Response } from "express";
import { ObjectId, type Filter, type Sort } from "mongodb";
import { getDB } from "../config/db.js";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { listBookingsQuerySchema, updateBookingStatusSchema, cancelBookingSchema, OBJECT_ID_HEX_REGEX } from "../validators/booking.validator.js";
import { createBookingWithScheduleSchema } from "../validators/features.validator.js";
import { createReviewSchema } from "../validators/review.validator.js";
import {
  getBookingsCollection,
  ACTIVE_BOOKING_STATUSES,
  type Booking,
  type BookingReview,
} from "../models/booking.model.js";
import { getServicesCollection } from "../models/service.model.js";
import { emitBookingEvent } from "../utils/booking-events.js";
import {
  SLOT_DURATION_MINUTES,
  isSlotInPast,
  isSlotTooFarAhead,
  validateScheduleShape,
  validateTechnicianSlot,
  findConflictingBooking,
  addMinutes,
} from "../utils/schedule.js";
import { toPublicTimeline } from "../utils/timeline.js";

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

// Identity comes exclusively from the verified JWT; a missing JWT payload
// is rejected here as defense-in-depth (the route middleware already
// enforces it). Shared by technician and customer endpoints.
const resolveAuthUserId = (
  req: AuthenticatedRequest
): ObjectId | null => {
  if (!req.user || !ObjectId.isValid(req.user.id)) {
    return null;
  }
  return new ObjectId(req.user.id);
};

const resolveTechnicianId = resolveAuthUserId;

const BOOKING_SORT: Sort = { createdAt: -1, _id: -1 };

// Safe DTO for the customer-owned booking-details endpoint. Contains only
// what a Booking Details page needs; internal MongoDB fields (_id,
// customerId, serviceId, securityDeposit) and sensitive account data
// (customerName/customerEmail, technicianEmail) are deliberately excluded.
interface BookingDetailsDTO {
  id: string;
  service: {
    title: string;
    category: Booking["serviceCategory"];
    location: string;
    image: string;
    hourlyRate: number;
  };
  technician: {
    id: string;
    name: string;
  };
  problemDescription: string;
  status: Booking["status"];
  paymentStatus: Booking["paymentStatus"];
  // Settled only when the job is completed; omitted until then.
  finalAmount?: number;
  // The customer's own review of this booking, when they have submitted one.
  review?: {
    rating: number;
    comment: string;
    createdAt: Date;
  };
  // Optional appointment schedule (backwards compatible).
  schedule?: {
    date: string;
    slotStart: string;
    slotEnd: string;
    durationMinutes: number;
    timezone: string;
  };
  // Server-written timeline events (never client-authored).
  timeline?: import("../utils/timeline.js").PublicTimelineEvent[];
  // Unread messages for the viewing participant.
  chatUnread?: number;
  // Invoice snapshot when issued (completed bookings only).
  invoice?: {
    number: string;
    issuedAt: Date;
    currency: string;
    serviceAmount: number;
    discountAmount: number;
    discountCode?: string;
    taxAmount: number;
    totalAmount: number;
    paymentStatus: string;
    paidAt?: Date;
    bookingReference: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const toPublicInvoice = (invoice: Booking["invoice"]) =>
  invoice
    ? {
        number: invoice.number,
        issuedAt: invoice.issuedAt,
        currency: invoice.currency,
        serviceAmount: invoice.serviceAmount,
        discountAmount: invoice.discountAmount,
        ...(invoice.discountCode ? { discountCode: invoice.discountCode } : {}),
        taxAmount: invoice.taxAmount,
        totalAmount: invoice.totalAmount,
        paymentStatus: invoice.paymentStatus,
        ...(invoice.paidAt ? { paidAt: invoice.paidAt } : {}),
        bookingReference: invoice.bookingReference,
      }
    : undefined;

const toPublicSchedule = (
  schedule: NonNullable<Booking["schedule"]>
): NonNullable<BookingDetailsDTO["schedule"]> => ({
  date: schedule.date,
  slotStart: schedule.slotStart,
  slotEnd: schedule.slotEnd,
  durationMinutes: schedule.durationMinutes,
  timezone: schedule.timezone,
});

const toBookingDetailsDTO = (
  booking: Booking,
  viewer?: { id: string; role: string }
): BookingDetailsDTO => {
  const dto: BookingDetailsDTO = {
    id: booking._id.toHexString(),
    service: {
      title: booking.serviceTitle,
      category: booking.serviceCategory,
      location: booking.serviceLocation,
      image: booking.serviceImage,
      hourlyRate: booking.hourlyRate,
    },
    technician: {
      id: booking.technicianId.toHexString(),
      name: booking.technicianName,
    },
    problemDescription: booking.problemDescription,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  };

  if (booking.finalAmount !== undefined) {
    dto.finalAmount = booking.finalAmount;
  }

  if (booking.review) {
    dto.review = {
      rating: booking.review.rating,
      comment: booking.review.comment,
      createdAt: booking.review.createdAt,
    };
  }

  if (booking.schedule) {
    dto.schedule = toPublicSchedule(booking.schedule);
  }

  if (Array.isArray(booking.timeline) && booking.timeline.length > 0) {
    dto.timeline = toPublicTimeline(booking.timeline);
  }

  if (booking.invoice) {
    dto.invoice = toPublicInvoice(booking.invoice);
  }

  if (viewer) {
    const messages = booking.conversation?.messages ?? [];
    dto.chatUnread = messages.filter(
      (message) =>
        message.senderId.toHexString() !== viewer.id && !message.readAt
    ).length;
  }

  return dto;
};

/**
 * Sanitized booking summary for create/list/transition responses. These
 * endpoints previously returned raw MongoDB documents including customer and
 * technician emails, security deposits and internal ObjectId references.
 * `_id` stays as the public hex string consumers already use for navigation;
 * no other internal field is exposed.
 */
interface BookingSummaryDTO {
  _id: string;
  customerName: string;
  technicianName: string;
  serviceTitle: string;
  serviceCategory: Booking["serviceCategory"];
  serviceLocation: string;
  serviceImage: string;
  hourlyRate: number;
  problemDescription: string;
  status: Booking["status"];
  paymentStatus: Booking["paymentStatus"];
  finalAmount?: number;
  schedule?: NonNullable<BookingDetailsDTO["schedule"]>;
  createdAt: Date;
  updatedAt: Date;
}

const toBookingSummaryDTO = (booking: Booking): BookingSummaryDTO => {
  const dto: BookingSummaryDTO = {
    _id: booking._id.toHexString(),
    customerName: booking.customerName,
    technicianName: booking.technicianName,
    serviceTitle: booking.serviceTitle,
    serviceCategory: booking.serviceCategory,
    serviceLocation: booking.serviceLocation,
    serviceImage: booking.serviceImage,
    hourlyRate: booking.hourlyRate,
    problemDescription: booking.problemDescription,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  };

  if (booking.finalAmount !== undefined) {
    dto.finalAmount = booking.finalAmount;
  }
  if (booking.schedule) {
    dto.schedule = toPublicSchedule(booking.schedule);
  }

  return dto;
};

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

  const parsed = createBookingWithScheduleSchema.safeParse(req.body);

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

  // --- Optional appointment schedule ---
  // Backward compatible: bookings without a schedule behave exactly as
  // before. When provided, every rule is validated server-side and the
  // unique partial index bookings_technician_schedule_active_unique is the
  // authoritative guard against concurrent slot claims.
  let schedule: import("../models/booking-extras.model.js").BookingSchedule | undefined;
  if (parsed.data.schedule) {
    const { date, slotStart, timezone } = parsed.data.schedule;
    const shapeError = validateScheduleShape({ date, slotStart, timezone });
    if (shapeError) {
      res.status(400).json({ success: false, message: shapeError.message });
      return;
    }
    if (isSlotTooFarAhead(date, timezone)) {
      res.status(400).json({
        success: false,
        message: "Appointments can be scheduled at most 60 days ahead.",
      });
      return;
    }
    if (isSlotInPast(date, slotStart, timezone)) {
      res.status(400).json({
        success: false,
        message: "Cannot schedule an appointment in the past.",
      });
      return;
    }

    // Technician availability (fresh DB read — never from the client).
    const technicianDoc = await getDB()
      .collection(USERS_COLLECTION)
      .findOne(
        { _id: service.technicianId },
        { projection: { availability: 1 } }
      );
    const slotError = validateTechnicianSlot(
      technicianDoc?.availability as import("../models/user-config.model.js").TechnicianAvailability | undefined,
      date,
      slotStart
    );
    if (slotError) {
      res.status(409).json({ success: false, message: slotError.message });
      return;
    }

    const conflict = await findConflictingBooking(service.technicianId, date, slotStart);
    if (conflict) {
      res.status(409).json({
        success: false,
        message: "That time slot was just taken for this technician. Please pick another slot.",
      });
      return;
    }

    const slotEnd = addMinutes(slotStart, SLOT_DURATION_MINUTES);
    if (!slotEnd) {
      res.status(400).json({ success: false, message: "Appointment slot crosses midnight." });
      return;
    }

    schedule = {
      date,
      slotStart,
      slotEnd,
      durationMinutes: SLOT_DURATION_MINUTES,
      timezone,
    };
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
    ...(schedule ? { schedule } : {}),
  };

  try {
    await getBookingsCollection().insertOne(booking);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Distinguish the schedule-slot partial unique index from the
      // customer-services duplicate index so the message is accurate.
      const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue ?? {};
      const isSlotConflict = "schedule.date" in keyValue || "schedule.slotStart" in keyValue;
      res.status(409).json({
        success: false,
        message: isSlotConflict
          ? "That time slot was just taken for this technician. Please pick another slot."
          : DUPLICATE_BOOKING_MESSAGE,
      });
      return;
    }
    throw error;
  }

  // Post-commit fan-out: timeline + notification (best effort, never
  // blocks the response).
  try {
    await emitBookingEvent(booking, "requested", "customer");
  } catch (error) {
    console.error("createBooking: post-commit event error:", error);
  }

  res.status(201).json({
    success: true,
    message: "Booking created successfully.",
    data: toBookingSummaryDTO(booking),
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

  const parsed = listBookingsQuerySchema.safeParse(req.query);

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
  } else {
    // Cancelled bookings are permanently retained but excluded from the
    // default list; pass ?status=cancelled to see only cancelled records.
    filter.status = { $ne: "cancelled" };
  }

  // Project away the potentially large embedded documents — list views
  // never need the conversation, timeline or invoice snapshot. The detail
  // endpoint returns those.
  const LIST_PROJECTION = { conversation: 0, timeline: 0, invoice: 0 } as const;

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const [items, totalItems] = await Promise.all([
    getBookingsCollection()
      .find(filter, { projection: LIST_PROJECTION })
      .sort(BOOKING_SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getBookingsCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

  res.status(200).json({
    success: true,
    data: items.map(toBookingSummaryDTO),
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

// Shared tail for the accept/reject/cancel transition helpers: after an
// atomic update fails to match, distinguish "booking not found / not owned
// by this caller" (404) from "owned but not in the expected state" (409).
// The lookup is scoped by the caller's ownership field so another user's
// booking is indistinguishable from a missing one.
const respondAfterFailedTransition = async (
  res: Response,
  bookingId: ObjectId,
  ownerFilter: { technicianId?: ObjectId; customerId?: ObjectId }
): Promise<void> => {
  const lookup: Filter<Booking> = { _id: bookingId };

  if (ownerFilter.technicianId) {
    lookup.technicianId = ownerFilter.technicianId;
  }

  if (ownerFilter.customerId) {
    lookup.customerId = ownerFilter.customerId;
  }

  const existing = await getBookingsCollection().findOne(lookup, {
    projection: { _id: 1 },
  });

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
    await respondAfterFailedTransition(res, bookingId, { technicianId });
    return;
  }

  // Timeline + notification after a successful authorized transition.
  try {
    await emitBookingEvent(
      updated,
      targetStatus === "accepted" ? "accepted" : "rejected",
      "technician"
    );
  } catch (error) {
    console.error(`accept/reject: post-commit event error (${targetStatus}):`, error);
  }

  res.status(200).json({
    success: true,
    message: successMessage,
    data: toBookingSummaryDTO(updated),
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
    await respondAfterFailedTransition(res, bookingId, { technicianId });
    return;
  }

  try {
    const timelineType = parsed.data.status === "in-progress" ? "started" : "completed";
    const note =
      parsed.data.status === "completed" && typeof updated.finalAmount === "number"
        ? `final amount ${updated.finalAmount}`
        : undefined;
    await emitBookingEvent(updated, timelineType, "technician", note);
  } catch (error) {
    console.error("updateBookingStatus: post-commit event error:", error);
  }

  res.status(200).json({
    success: true,
    message: transition.message,
    data: toBookingSummaryDTO(updated),
  });
};

// GET /api/bookings/my — customer only (verifyToken -> verifyCustomer).
// Returns only bookings whose customerId matches the verified JWT; any
// customerId in the query string is stripped by the schema and ignored.
// Same filtering/pagination/metadata convention as the technician list.
export const listMyBookings = async (
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

  const customerId = resolveAuthUserId(req);

  if (!customerId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const parsed = listBookingsQuerySchema.safeParse(req.query);

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

  const filter: Filter<Booking> = { customerId };

  if (status) {
    filter.status = status;
  } else {
    // Cancelled bookings are permanently retained but excluded from the
    // default list; pass ?status=cancelled to see only cancelled records.
    filter.status = { $ne: "cancelled" };
  }

  // Project away the potentially large embedded documents — list views
  // never need the conversation, timeline or invoice snapshot. The detail
  // endpoint returns those.
  const LIST_PROJECTION = { conversation: 0, timeline: 0, invoice: 0 } as const;

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const [items, totalItems] = await Promise.all([
    getBookingsCollection()
      .find(filter, { projection: LIST_PROJECTION })
      .sort(BOOKING_SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getBookingsCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

  res.status(200).json({
    success: true,
    data: items.map(toBookingSummaryDTO),
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

// PATCH /api/bookings/:id/cancel — customer only (verifyToken -> verifyCustomer).
// Atomically moves the customer's own booking from "requested" to
// "cancelled". No body fields are accepted. The {_id, customerId,
// status: "requested"} filter is the only transition guard; the second
// lookup only distinguishes 404 from 409 and never authorizes a write.
export const cancelBooking = async (
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

  const customerId = resolveAuthUserId(req);

  if (!customerId) {
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

  // Cancellation accepts no client input at all; any body fields are
  // rejected (consistent with the strict-object convention).
  const parsed = cancelBookingSchema.safeParse(req.body ?? {});

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

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const updated = await getBookingsCollection().findOneAndUpdate(
    { _id: bookingId, customerId, status: "requested" },
    { $set: { status: "cancelled", updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!updated) {
    await respondAfterFailedTransition(res, bookingId, { customerId });
    return;
  }

  try {
    await emitBookingEvent(updated, "cancelled", "customer");
  } catch (error) {
    console.error("cancelBooking: post-commit event error:", error);
  }

  res.status(200).json({
    success: true,
    message: "Booking cancelled successfully.",
    data: toBookingSummaryDTO(updated),
  });
};

// GET /api/bookings/:id — customer only (verifyToken -> verifyCustomer).
// Returns the safe Booking Details DTO for the authenticated customer's
// own booking only: the {_id, customerId} filter makes another customer's
// booking indistinguishable from a missing one (404 either way). Identity
// comes exclusively from the verified JWT; any customerId in the query
// string or body is ignored (this handler never reads either).
export const getBookingDetails = async (
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

  const customerId = resolveAuthUserId(req);

  if (!customerId) {
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
  const booking = await getBookingsCollection().findOne({
    _id: bookingId,
    customerId,
  });

  if (!booking) {
    res.status(404).json({
      success: false,
      message: "Booking not found.",
    });
    return;
  }

  res.status(200).json({
    success: true,
    data: toBookingDetailsDTO(booking, req.user ? { id: req.user.id, role: req.user.role } : undefined),
  });
};

// POST /api/bookings/:id/review — customer only (verifyToken -> verifyCustomer).
//
// Review eligibility and security, all enforced server-side:
//   - Identity comes exclusively from the verified JWT (req.user); any
//     customerId/technicianId/serviceId in the body is rejected by the
//     strict validator and never read.
//   - Only the customer who owns the booking may review it. The atomic
//     update filter includes { _id, customerId }, so another customer's
//     booking is indistinguishable from a missing one (404 either way).
//   - Only completed bookings are eligible; the filter requires
//     status: "completed", enforced atomically at write time.
//   - One review per booking: the filter requires review $exists: false, so
//     a second submission matches nothing and is rejected with 409.
//   - Technicians and admins never reach this handler (verifyCustomer).
// The post-failure lookup runs only after the atomic update matched nothing;
// it distinguishes 404 (no such booking for this customer) from 409 (not
// completed / already reviewed) and never authorizes a write.
export const submitReview = async (
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

  const customerId = resolveAuthUserId(req);

  if (!customerId) {
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

  const parsed = createReviewSchema.safeParse(req.body ?? {});

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

  const now = new Date();
  const review: BookingReview = {
    rating: parsed.data.rating,
    comment: parsed.data.comment,
    createdAt: now,
  };

  // Atomic transition: the review is written iff the booking is owned by this
  // customer, completed, and carries no review yet.
  const updated = await getBookingsCollection().findOneAndUpdate(
    {
      _id: bookingId,
      customerId,
      status: "completed",
      review: { $exists: false },
    },
    { $set: { review, updatedAt: now } },
    { returnDocument: "after" }
  );

  if (!updated) {
    const existing = await getBookingsCollection().findOne(
      { _id: bookingId, customerId },
      { projection: { _id: 1, status: 1, review: 1 } }
    );

    if (!existing) {
      res.status(404).json({
        success: false,
        message: "Booking not found.",
      });
      return;
    }

    if (existing.status !== "completed") {
      res.status(409).json({
        success: false,
        message: "Only completed bookings can be reviewed.",
      });
      return;
    }

    res.status(409).json({
      success: false,
      message: "This booking has already been reviewed.",
    });
    return;
  }

  res.status(201).json({
    success: true,
    message: "Review submitted successfully.",
    data: {
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt,
    },
  });
};
