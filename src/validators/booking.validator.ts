
import { z } from "zod";

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
