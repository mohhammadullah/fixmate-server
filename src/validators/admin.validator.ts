import { z } from "zod";
import { BOOKING_STATUSES, PAYMENT_STATUSES } from "../models/booking.model.js";
import { escapeRegExp } from "../validators/service.validator.js";

const positiveInt = z.coerce.number().int().min(1).optional();
const limitedInt = z.coerce.number().int().min(1).max(50).optional();
const trimmedQuery = z
  .string()
  .trim()
  .max(200, "Search must be at most 200 characters long")
  .optional();

export const adminUsersQuerySchema = z.object({
  search: trimmedQuery,
  role: z.enum(["customer", "technician", "admin"], {
    error: "Role must be one of: customer, technician, admin",
  }).optional(),
  page: positiveInt,
  limit: limitedInt,
});

export const adminBookingsQuerySchema = z.object({
  search: trimmedQuery,
  status: z.enum(BOOKING_STATUSES, {
    error: `Status must be one of: ${BOOKING_STATUSES.join(", ")}`,
  }).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES, {
    error: `Payment status must be one of: ${PAYMENT_STATUSES.join(", ")}`,
  }).optional(),
  page: positiveInt,
  limit: limitedInt,
});

// Admin role assignment is intentionally excluded: the first admin can only
// be created by the server-side bootstrap script.
export const updateUserRoleSchema = z.strictObject({
  role: z.enum(["customer", "technician"], {
    error: "Role must be either customer or technician",
  }),
});

export const adminSearchFilter = (search: string | undefined) =>
  search ? escapeRegExp(search) : null;
