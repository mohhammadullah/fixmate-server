import { z } from "zod";
import {
  BOOKING_STATUSES,
  PAYMENT_STATUSES,
} from "../models/booking.model.js";
import { SERVICE_APPROVAL_STATUSES } from "../models/service.model.js";
// The payments collection has its own lifecycle (pending/succeeded/failed/expired),
// exported from payment.model.js under the same name — alias to avoid collision
// with the booking-level PAYMENT_STATUSES above.
import { PAYMENT_STATUSES as PAYMENT_RECORD_STATUSES } from "../models/payment.model.js";
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

// Admin payments listing (GET /api/admin/payments). Strict validation;
// unknown query keys are stripped. `from`/`to` are inclusive calendar days
// (YYYY-MM-DD, interpreted in UTC). Chosen behaviour as elsewhere: a limit
// above 50 is rejected with 400 rather than silently capped.
const dateQuerySchema = z
  .string({ error: "Date must be a string in YYYY-MM-DD format" })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Date must be valid")
  .optional();

export const adminPaymentsQuerySchema = z
  .object({
    status: z.enum(PAYMENT_RECORD_STATUSES, {
      error: `Status must be one of: ${PAYMENT_RECORD_STATUSES.join(", ")}`,
    }).optional(),
    from: dateQuerySchema,
    to: dateQuerySchema,
    search: trimmedQuery,
    page: positiveInt,
    limit: limitedInt,
  })
  .refine(
    (data) => !data.from || !data.to || data.from <= data.to,
    { message: "from must be on or before to", path: ["from"] }
  );

// Admin service moderation listing. Defaults to pending services — this is
// the review queue. Other statuses remain available for follow-up.
export const adminServicesQuerySchema = z.object({
  status: z.enum(SERVICE_APPROVAL_STATUSES, {
    error: `Status must be one of: ${SERVICE_APPROVAL_STATUSES.join(", ")}`,
  }).default("pending"),
  search: trimmedQuery,
  page: positiveInt,
  limit: limitedInt,
});

// Admin role assignment: an authenticated Admin may promote an existing
// customer/technician to Admin through PATCH /api/admin/users/:id/role.
// Demotion of ANY admin is restricted to the Main Admin (see the controller
// for the exact rules): Normal Admins can never demote an Admin, and the
// Main Admin cannot be demoted or modified at all. Creating the FIRST admin
// remains the server-side bootstrap script's job — there is no public path
// to become an admin from nothing.
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

export const updateUserRoleSchema = z.strictObject({
  role: z.enum(["customer", "technician", "admin"], {
    error: "Role must be one of: customer, technician, admin",
  }),
});

// POST /api/admin/main-admin/transfer — hand Main Admin ownership to another
// existing Normal Admin. Requires the current Main Admin's password for
// re-authentication. Target must be a different, existing Normal Admin.
export const mainAdminTransferSchema = z.strictObject({
  targetUserId: z
    .string({ error: "targetUserId is required and must be a string" })
    .trim()
    .regex(
      OBJECT_ID_HEX,
      "targetUserId must be a 24-character hexadecimal ObjectId"
    ),
  password: z
    .string({ error: "Password is required and must be a string" })
    .min(1, "Password is required")
    .max(200, "Password must be at most 200 characters long"),
});

export type UpdateUserRoleInput = z.input<typeof updateUserRoleSchema>;
export type UpdateUserRoleData = z.infer<typeof updateUserRoleSchema>;
export type MainAdminTransferInput = z.input<typeof mainAdminTransferSchema>;
export type MainAdminTransferData = z.infer<typeof mainAdminTransferSchema>;
export type AdminUsersQueryData = z.infer<typeof adminUsersQuerySchema>;
export type AdminBookingsQueryData = z.infer<typeof adminBookingsQuerySchema>;
export type AdminServicesQueryData = z.infer<typeof adminServicesQuerySchema>;
export type AdminPaymentsQueryData = z.infer<typeof adminPaymentsQuerySchema>;

export const adminSearchFilter = (search: string | undefined) =>
  search ? escapeRegExp(search) : null;
