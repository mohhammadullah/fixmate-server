
import type { Response } from "express";
import { ObjectId, type Document } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import {
  getUsersCollection,
  USERS_COLLECTION,
} from "../models/technician-application.model.js";
import {
  upsertAvailabilitySchema,
  availabilityQuerySchema,
} from "../validators/features.validator.js";
import { getDB } from "../config/db.js";
import {
  DEFAULT_TIMEZONE,
  DEFAULT_WEEKLY_SCHEDULE,
} from "../utils/schedule.js";
import type { TechnicianAvailability } from "../models/user-config.model.js";
import {
  MAX_SERVICE_AREAS,
  MAX_UNAVAILABLE_DATES,
} from "../models/user-config.model.js";

// Technician availability management (self-service, role-gated).

const publicAvailability = (
  availability: TechnicianAvailability | null | undefined
): Omit<TechnicianAvailability, "serviceAreas"> & { serviceAreas: string[] } => ({
  status: availability?.status ?? "available",
  weekly: availability?.weekly?.length === 7
    ? availability.weekly
    : DEFAULT_WEEKLY_SCHEDULE,
  unavailableDates: availability?.unavailableDates ?? [],
  serviceAreas: availability?.serviceAreas ?? [],
  timezone: availability?.timezone ?? DEFAULT_TIMEZONE,
  updatedAt: availability?.updatedAt ?? new Date(0),
});

export const getMyAvailability = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;
  if (!authUser || !ObjectId.isValid(authUser.id)) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const dbUser = await getUsersCollection().findOne(
    { _id: new ObjectId(authUser.id) },
    { projection: { availability: 1 } }
  );

  res.status(200).json({
    success: true,
    data: publicAvailability(dbUser?.availability as TechnicianAvailability | undefined),
  });
};

export const upsertMyAvailability = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;
  if (!authUser || !ObjectId.isValid(authUser.id)) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const parsed = upsertAvailabilitySchema.safeParse(req.body ?? {});
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
  const availability: TechnicianAvailability = {
    status: parsed.data.status,
    weekly: parsed.data.weekly,
    unavailableDates: [...new Set(parsed.data.unavailableDates)].slice(0, MAX_UNAVAILABLE_DATES),
    serviceAreas: [...new Set(parsed.data.serviceAreas.map((a) => a.trim()))].slice(0, MAX_SERVICE_AREAS),
    timezone: parsed.data.timezone,
    updatedAt: now,
  };

  const update: Document = { $set: { availability, updatedAt: now } };
  const result = await getUsersCollection().updateOne(
    { _id: new ObjectId(authUser.id) },
    update
  );

  if (result.matchedCount === 0) {
    res.status(404).json({ success: false, message: "Account not found." });
    return;
  }

  res.status(200).json({
    success: true,
    message: "Availability updated successfully.",
    data: publicAvailability(availability),
  });
};

/**
 * GET /api/services/:id/availability[?date=YYYY-MM-DD]
 * Any authenticated user. Resolves the technician from the *service* (the
 * public DTO never leaks the technician's user id) and returns their public
 * working pattern + (when ?date is given) already-booked hourly slots for
 * that day. Never exposes private account fields.
 */
export const getServiceAvailabilityPublic = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (typeof rawId !== "string" || !/^[0-9a-fA-F]{24}$/.test(rawId)) {
    res.status(400).json({ success: false, message: "Invalid service id." });
    return;
  }

  const parsed = availabilityQuerySchema.safeParse(req.query);
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

  const service = await getDB()
    .collection("services")
    .findOne(
      { _id: new ObjectId(rawId), approvalStatus: "approved", availabilityStatus: "available" },
      { projection: { technicianId: 1 } }
    );

  if (!service) {
    res.status(404).json({ success: false, message: "Service not found." });
    return;
  }

  const technicianId = (service as unknown as { technicianId: ObjectId }).technicianId;
  const dbUser = await getDB()
    .collection(USERS_COLLECTION)
    .findOne({ _id: technicianId }, { projection: { availability: 1 } });

  if (!dbUser) {
    res.status(404).json({ success: false, message: "Technician not found." });
    return;
  }

  const base = publicAvailability(dbUser.availability as TechnicianAvailability | undefined);
  const response: Record<string, unknown> = { ...base };

  if (parsed.data.date) {
    const booked = await getDB()
      .collection("bookings")
      .find(
        {
          technicianId,
          status: { $in: ["requested", "accepted", "in-progress"] },
          "schedule.date": parsed.data.date,
        },
        { projection: { "schedule.slotStart": 1 } }
      )
      .toArray();
    response.bookedSlots = booked
      .map((doc) => (doc as { schedule?: { slotStart?: string } }).schedule?.slotStart)
      .filter((slot): slot is string => typeof slot === "string" && slot.length > 0)
      .sort();
  }

  res.status(200).json({ success: true, data: response });
};

/**
 * GET /api/technicians/:id/availability[?date=YYYY-MM-DD]
 * Any authenticated user. Returns the technician's public working pattern +
 * (when ?date is given) the list of already-booked hourly slots for that
 * day — enough for the booking UI to grey out taken times. Never exposes
 * private account fields.
 */
export const getTechnicianAvailabilityPublic = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (typeof rawId !== "string" || !/^[0-9a-fA-F]{24}$/.test(rawId)) {
    res.status(400).json({ success: false, message: "Invalid technician id." });
    return;
  }

  const parsed = availabilityQuerySchema.safeParse(req.query);
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

  const dbUser = await getDB()
    .collection(USERS_COLLECTION)
    .findOne({ _id: new ObjectId(rawId) }, { projection: { availability: 1 } });

  if (!dbUser) {
    // Do not reveal whether the technician exists beyond what booking needs.
    res.status(404).json({ success: false, message: "Technician not found." });
    return;
  }

  const base = publicAvailability(dbUser.availability as TechnicianAvailability | undefined);
  const response: Record<string, unknown> = { ...base };

  if (parsed.data.date) {
    const booked = await getDB()
      .collection("bookings")
      .find(
        {
          technicianId: new ObjectId(rawId),
          status: { $in: ["requested", "accepted", "in-progress"] },
          "schedule.date": parsed.data.date,
        },
        { projection: { "schedule.slotStart": 1 } }
      )
      .toArray();
    response.bookedSlots = booked
      .map((doc) => (doc as { schedule?: { slotStart?: string } }).schedule?.slotStart)
      .filter((slot): slot is string => typeof slot === "string" && slot.length > 0)
      .sort();
  }

  res.status(200).json({ success: true, data: response });
};
