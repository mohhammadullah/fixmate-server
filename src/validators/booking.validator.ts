
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

// Booking-list query shared by the technician and customer list endpoints.
// Unknown query keys (including any technicianId/customerId) are stripped —
// never trusted. Empty strings are rejected. Chosen behavior: a limit above
// 50 is rejected with HTTP 400 rather than silently capped.
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

export const listBookingsQuerySchema = z.object({
  status: z
    .enum(BOOKING_STATUSES, {
      error: `Status must be one of: ${BOOKING_STATUSES.join(", ")}`,
    })
    .optional(),
  page: positiveIntQuerySchema("page"),
  limit: positiveIntQuerySchema("limit", 50),
});

// Technician status-workflow transitions. Two allowed shapes only:
//   { "status": "in-progress" }
//   { "status": "completed", "finalAmount": <finite positive number> }
// Ownership/workflow/settlement fields are server-controlled and deliberately
// absent: both arms are strict objects, so unexpected keys (technicianId,
// customerId, paymentStatus, finalAmount-on-in-progress, timestamps, …) are
// rejected. `finalAmount` is the technician's final repair charge at this
// stage — it is NOT a payment.
export const updateBookingStatusSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("in-progress"),
  }),
  z.strictObject({
    status: z.literal("completed"),
    finalAmount: z
      .number({
        error: "finalAmount is required and must be a number when completing a booking",
      })
      .finite("finalAmount must be a finite number")
      .positive("finalAmount must be greater than 0"),
  }),
]);

export type ListBookingsQueryInput = z.input<typeof listBookingsQuerySchema>;
export type ListBookingsQueryData = z.infer<typeof listBookingsQuerySchema>;
// Customer cancellation takes no input at all: the booking is identified by
// the route param and the customer by the verified JWT. An empty strict
// object rejects any client-supplied body fields (consistent with the
// strict-object convention used elsewhere). Use via
// cancelBookingSchema.safeParse(req.body ?? {}).
export const cancelBookingSchema = z.strictObject({});

export type CancelBookingInput = z.input<typeof cancelBookingSchema>;
export type UpdateBookingStatusInput = z.input<typeof updateBookingStatusSchema>;
export type UpdateBookingStatusData = z.infer<typeof updateBookingStatusSchema>;
