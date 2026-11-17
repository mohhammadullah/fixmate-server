
import { z } from "zod";
import { BOOKING_STATUSES } from "../models/booking.model.js";

// Strict 24-character hexadecimal ObjectId (ObjectId.isValid would also
// accept 12-byte strings, so check explicitly).
export const OBJECT_ID_HEX_REGEX = /^[0-9a-fA-F]{24}$/;

// Customer-editable booking fields only. Ownership (customerId,
// technicianId), workflow (status, paymentStatus), settlement (finalAmount),
// snapshots, and timestamps are server-controlled and deliberately absent:
// z.strictObject rejects any key outside this shape.
export const createBookingSchema = z.strictObject({
  serviceId: z
    .string({ error: "serviceId is required and must be a string" })
    .trim()
    .regex(
      OBJECT_ID_HEX_REGEX,
      "serviceId must be a 24-character hexadecimal ObjectId"
    ),
  problemDescription: z
    .string({ error: "Problem description is required and must be a string" })
    .trim()
    .min(10, "Problem description must be at least 10 characters long")
    .max(2000, "Problem description must be at most 2000 characters long"),
});

export type CreateBookingInput = z.input<typeof createBookingSchema>;
export type CreateBookingData = z.infer<typeof createBookingSchema>;

// Technician booking-list query. Unknown query keys (including any
// technicianId) are stripped — never trusted. Empty strings are rejected.
// Chosen behavior: a limit above 50 is rejected with HTTP 400 rather than
// silently capped.
const positiveIntQuerySchema = (label: string, max?: number) => {
  const base = z
    .string({ error: `${label} must be a string` })
    .trim()
    .refine(
      (value) => /^[1-9]\d*$/.test(value),
      `${label} must be a positive integer`
    )
    .transform(Number)
    .pipe(z.number().int().min(1, `${label} must be at least 1`));

  return (
    max === undefined
      ? base
      : base.pipe(z.number().int().max(max, `${label} must be at most ${max}`))
  ).optional();
};

export const listTechnicianBookingsQuerySchema = z.object({
  status: z
    .enum(BOOKING_STATUSES, {
      error: `Status must be one of: ${BOOKING_STATUSES.join(", ")}`,
    })
    .optional(),
  page: positiveIntQuerySchema("page"),
  limit: positiveIntQuerySchema("limit", 50),
});

export type ListTechnicianBookingsQueryInput = z.input<typeof listTechnicianBookingsQuerySchema>;
export type ListTechnicianBookingsQueryData = z.infer<typeof listTechnicianBookingsQuerySchema>;
