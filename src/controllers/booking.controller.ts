
import type { Response } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { createBookingSchema } from "../validators/booking.validator.js";
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
