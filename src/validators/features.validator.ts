
import { z } from "zod";
import {
  TIME_RE,
  DATE_RE,
  SLOT_START_RE,
  isValidTimezone,
  parseLocalDate,
  minutesOf,
  DEFAULT_WEEKLY_SCHEDULE,
} from "../utils/schedule.js";
import { AVAILABILITY_STATUSES } from "../models/user-config.model.js";

// ------------------------- Technician availability -------------------------

const timeSchema = z
  .string({ error: "Time must be a string" })
  .regex(TIME_RE, "Time must be in 24-hour HH:MM format");

const breakSchema = z.strictObject({
  start: timeSchema,
  end: timeSchema,
}).refine(
  (value) => minutesOf(value.start)! < minutesOf(value.end)!,
  { message: "Break start must be before break end" }
);

const weeklyDaySchema = z.strictObject({
  day: z
    .number({ error: "day must be a number" })
    .int("day must be an integer")
    .min(0, "day must be 0-6")
    .max(6, "day must be 0-6"),
  enabled: z.boolean({ error: "enabled must be a boolean" }),
  start: timeSchema,
  end: timeSchema,
  breaks: z.array(breakSchema).max(3, "At most 3 breaks per day"),
}).refine(
  (value) => {
    const start = minutesOf(value.start);
    const end = minutesOf(value.end);
    return start !== null && end !== null && start < end;
  },
  { message: "Working start must be before working end" }
);

export const upsertAvailabilitySchema = z.strictObject({
  status: z.enum(AVAILABILITY_STATUSES, {
    error: `status must be one of: ${AVAILABILITY_STATUSES.join(", ")}`,
  }),
  weekly: z
    .array(weeklyDaySchema, { error: "weekly must be an array" })
    .length(7, "weekly must contain exactly 7 days")
    .refine(
      (days) => new Set(days.map((d) => d.day)).size === 7,
      { message: "weekly days must be unique (0-6)" }
    ),
  unavailableDates: z
    .array(
      z
        .string({ error: "Dates must be strings" })
        .regex(DATE_RE, "Dates must be YYYY-MM-DD")
        .refine((value) => parseLocalDate(value) !== null, {
          message: "Dates must be valid calendar dates",
        })
    )
    .max(60, "At most 60 unavailable dates"),
  serviceAreas: z
    .array(
      z
        .string({ error: "Service areas must be strings" })
        .trim()
        .min(2, "Service areas must be at least 2 characters")
        .max(80, "Service areas must be at most 80 characters")
    )
    .max(10, "At most 10 service areas"),
  timezone: z
    .string({ error: "timezone must be a string" })
    .trim()
    .min(1, "timezone is required")
    .max(64, "timezone must be at most 64 characters")
    .refine(isValidTimezone, { message: "timezone must be a valid IANA timezone" }),
});

export type UpsertAvailabilityData = z.infer<typeof upsertAvailabilitySchema>;

// ------------------------------ Scheduling ------------------------------

export const scheduleInputSchema = z.strictObject({
  date: z
    .string({ error: "date is required and must be a string" })
    .trim()
    .regex(DATE_RE, "date must be YYYY-MM-DD"),
  slotStart: z
    .string({ error: "slotStart is required and must be a string" })
    .trim()
    .regex(SLOT_START_RE, "slotStart must be hourly (HH:00)"),
  timezone: z
    .string({ error: "timezone is required and must be a string" })
    .trim()
    .max(64, "timezone must be at most 64 characters")
    .refine(isValidTimezone, { message: "timezone must be a valid IANA timezone" }),
});

export type ScheduleInputData = z.infer<typeof scheduleInputSchema>;

export const createBookingWithScheduleSchema = z.strictObject({
  serviceId: z
    .string({ error: "serviceId is required and must be a string" })
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "serviceId must be a 24-character hex ObjectId"),
  problemDescription: z
    .string({ error: "problemDescription is required and must be a string" })
    .trim()
    .min(10, "Problem description must be at least 10 characters long")
    .max(2000, "Problem description must be at most 2000 characters long"),
  /** Optional — backwards compatible: bookings without schedule are allowed. */
  schedule: scheduleInputSchema.optional(),
});

export type CreateBookingWithScheduleData = z.infer<typeof createBookingWithScheduleSchema>;

export const availabilityQuerySchema = z.object({
  /** Optional ISO date to preview a specific day; defaults to the 14-day horizon. */
  date: z
    .string({ error: "date must be a string" })
    .trim()
    .regex(DATE_RE, "date must be YYYY-MM-DD")
    .optional(),
});

// --------------------------------- Chat ---------------------------------

export const sendChatMessageSchema = z.strictObject({
  text: z
    .string({ error: "text is required and must be a string" })
    .trim()
    .min(1, "Message cannot be empty")
    .max(500, "Message must be at most 500 characters"),
});

export type SendChatMessageData = z.infer<typeof sendChatMessageSchema>;

export const chatQuerySchema = z.object({
  before: z
    .string({ error: "before must be a string" })
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "before must be a 24-character hex message id")
    .optional(),
  limit: z
    .string({ error: "limit must be a string" })
    .trim()
    .refine((v) => /^[1-9]\d*$/.test(v), "limit must be a positive integer")
    .transform(Number)
    .pipe(z.number().int().min(1).max(50, "limit must be at most 50"))
    .optional(),
});

export const bookingIdParamSchema = z
  .string({ error: "booking id must be a string" })
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "booking id must be a 24-character hex ObjectId");

// ----------------------------- Notifications -----------------------------

export const notificationsQuerySchema = z.object({
  page: z
    .string({ error: "page must be a string" })
    .trim()
    .refine((v) => /^[1-9]\d*$/.test(v), "page must be a positive integer")
    .transform(Number)
    .pipe(z.number().int().min(1))
    .optional(),
  limit: z
    .string({ error: "limit must be a string" })
    .trim()
    .refine((v) => /^[1-9]\d*$/.test(v), "limit must be a positive integer")
    .transform(Number)
    .pipe(z.number().int().min(1).max(50, "limit must be at most 50"))
    .optional(),
  unreadOnly: z
    .enum(["true", "false"], { error: "unreadOnly must be true or false" })
    .optional(),
});

export const notificationIdParamSchema = z
  .string({ error: "notification id must be a string" })
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "notification id must be a 24-character hex id");

export const couponIdParamSchema = z
  .string({ error: "coupon code must be a string" })
  .trim()
  .min(3, "coupon code is too short")
  .max(32, "coupon code is too long")
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z0-9_\-]+$/.test(v), {
    message: "coupon code may only contain A-Z, 0-9, _ and -",
  });

// ------------------------------- Coupons ---------------------------------

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/;

const isStrictCalendarDate = (value: string): boolean => {
  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly) {
    return parseLocalDate(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`) !== null;
  }
  const isoPrefix = ISO_DATE_PREFIX_RE.exec(value);
  if (isoPrefix) {
    return parseLocalDate(`${isoPrefix[1]}-${isoPrefix[2]}-${isoPrefix[3]}`) !== null;
  }
  return true;
};

const couponDateSchema = (label: string) =>
  z
    .union([z.date(), z.string()], {
      error: `${label} is required and must be a date`,
    })
    .superRefine((value, ctx) => {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          ctx.addIssue({ code: "custom", message: `${label} must be a valid date` });
        }
        return;
      }
      if (typeof value !== "string" || value.trim().length === 0) {
        ctx.addIssue({ code: "custom", message: `${label} is required and must be a date` });
        return;
      }
      const trimmed = value.trim();
      if (!isStrictCalendarDate(trimmed)) {
        ctx.addIssue({ code: "custom", message: `${label} must be a valid calendar date` });
        return;
      }
      if (Number.isNaN(new Date(trimmed).getTime())) {
        ctx.addIssue({ code: "custom", message: `${label} must be a valid date` });
      }
    })
    .transform((value) => (value instanceof Date ? value : new Date(value.trim())));

const couponCodeFieldSchema = z
  .string({ error: "code is required and must be a string" })
  .trim()
  .min(3, "code must be at least 3 characters")
  .max(32, "code must be at most 32 characters")
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z0-9_\-]+$/.test(v), {
    message: "code may only contain A-Z, 0-9, _ and -",
  });

const couponGlobalLimitSchema = z
  .number({ error: "globalLimit must be a number" })
  .int("globalLimit must be an integer")
  .positive("globalLimit must be at least 1")
  .max(1_000_000, "globalLimit is too large");

const couponPerCustomerLimitSchema = z
  .number({ error: "perCustomerLimit must be a number" })
  .int("perCustomerLimit must be an integer")
  .positive("perCustomerLimit must be at least 1")
  .max(1000, "perCustomerLimit is too large");

const couponMaxDiscountSchema = z
  .number({ error: "maxDiscount must be a number" })
  .finite()
  .positive("maxDiscount must be greater than 0")
  .max(1_000_000, "maxDiscount is too large");

export const couponKindSchema = z.enum(["fixed", "percent"], {
  error: "kind must be fixed or percent",
});

const couponFieldRules = (
  value: {
    kind: "fixed" | "percent";
    value: number;
    currency?: string;
  },
  ctx: z.RefinementCtx
) => {
  if (value.kind === "percent" && value.value > 100) {
    ctx.addIssue({
      code: "custom",
      message: "percent coupons must be at most 100",
      path: ["value"],
    });
  }
  if (
    value.kind === "fixed" &&
    (typeof value.currency !== "string" || value.currency.length !== 3)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "fixed coupons require a 3-letter ISO 4217 currency",
      path: ["currency"],
    });
  }
};

export const upsertCouponSchema = z
  .strictObject({
    code: couponCodeFieldSchema,
    kind: couponKindSchema,
    value: z
      .number({ error: "value is required and must be a number" })
      .finite("value must be finite")
      .positive("value must be greater than 0")
      .max(1_000_000, "value is too large"),
    currency: z
      .string({ error: "currency must be a string" })
      .trim()
      .max(8, "currency must be at most 8 characters")
      .transform((v) => v.toLowerCase())
      .optional(),
    minBookingAmount: z
      .number({ error: "minBookingAmount must be a number" })
      .finite()
      .min(0, "minBookingAmount must be >= 0")
      .max(10_000_000, "minBookingAmount is too large")
      .default(0),
    maxDiscount: couponMaxDiscountSchema.optional(),
    startsAt: couponDateSchema("startsAt"),
    expiresAt: couponDateSchema("expiresAt"),
    globalLimit: couponGlobalLimitSchema.optional(),
    perCustomerLimit: couponPerCustomerLimitSchema.default(1),
    categories: z
      .array(z.string().trim().min(1).max(60))
      .max(20, "At most 20 categories")
      .optional(),
    active: z.boolean({ error: "active must be a boolean" }).default(true),
  })
  .superRefine((value, ctx) => {
    if (value.startsAt.getTime() >= value.expiresAt.getTime()) {
      ctx.addIssue({
        code: "custom",
        message: "startsAt must be before expiresAt",
        path: ["expiresAt"],
      });
    }
    couponFieldRules(value, ctx);
  });

export const updateCouponSchema = z
  .strictObject({
    active: z.boolean({ error: "active must be a boolean" }).optional(),
    expiresAt: couponDateSchema("expiresAt").optional(),
    perCustomerLimit: couponPerCustomerLimitSchema.optional(),
    // null removes the existing global limit.
    globalLimit: z
      .union([couponGlobalLimitSchema, z.null()], {
        error: "globalLimit must be a positive integer or null",
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "No editable fields provided.",
      });
    }
  });

export type UpsertCouponData = z.infer<typeof upsertCouponSchema>;

export const applyCouponSchema = z.strictObject({
  code: z
    .string({ error: "code is required and must be a string" })
    .trim()
    .min(3, "code is too short")
    .max(32, "code is too long")
    .transform((v) => v.toUpperCase()),
  bookingId: z
    .string({ error: "bookingId is required and must be a string" })
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "bookingId must be a 24-character hex ObjectId"),
});

export type ApplyCouponData = z.infer<typeof applyCouponSchema>;

// -------------------------------- Refunds ---------------------------------

export const refundRequestSchema = z.strictObject({
  reason: z
    .string({ error: "reason is required and must be a string" })
    .trim()
    .min(10, "reason must be at least 10 characters")
    .max(500, "reason must be at most 500 characters"),
});

export const refundDecisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject"], {
    error: "decision must be approve or reject",
  }),
  note: z
    .string({ error: "note must be a string" })
    .trim()
    .max(300, "note must be at most 300 characters")
    .optional(),
});

export const refundIdParamSchema = z.object({
  paymentId: z
    .string({ error: "paymentId is required" })
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "paymentId must be a 24-character hex ObjectId"),
  refundId: z
    .string({ error: "refundId is required" })
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "refundId must be a 24-character hex id"),
});

export const paymentIdParamSchema = z
  .string({ error: "paymentId must be a string" })
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "paymentId must be a 24-character hex ObjectId");

// ------------------------------ Analytics ---------------------------------

export const analyticsQuerySchema = z.object({
  from: z
    .string({ error: "from must be a string" })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD")
    .optional(),
  to: z
    .string({ error: "to must be a string" })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD")
    .optional(),
}).refine(
  (value) => !value.from || !value.to || value.from <= value.to,
  { message: "from must be on or before to" }
);

// Keep the weekly-schedule default visible to callers who need it.
export const defaultWeeklySchedule = DEFAULT_WEEKLY_SCHEDULE;
