
import { ObjectId } from "mongodb";

/**
 * Embedded configuration and profile extensions stored on existing `user`
 * documents. No new application-owned collection is introduced.
 *
 * Bounded-growth guarantees:
 * - availability weekly schedule is exactly 7 entries (one per weekday)
 * - unavailableDates is capped (60) and validated as ISO date strings
 * - serviceAreas is capped (10)
 * - notifications are capped (50) — insertion trims with $slice
 * - coupons are capped (200) and only editable by the Main Admin
 */

export const AVAILABILITY_STATUSES = ["available", "busy"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const MAX_UNAVAILABLE_DATES = 60;
export const MAX_SERVICE_AREAS = 10;
export const MAX_NOTIFICATIONS = 50;
export const MAX_COUPONS = 200;

export interface WeeklyDaySchedule {
  /** 0 = Sunday … 6 = Saturday (UTC day-of-week, timezone-independent weekday semantics via UTC-noon parse). */
  day: number;
  enabled: boolean;
  /** Local wall-clock "HH:MM" in the technician's configured timezone. */
  start: string;
  end: string;
  breaks: Array<{ start: string; end: string }>;
}

export interface TechnicianAvailability {
  status: AvailabilityStatus;
  /** Exactly 7 entries, day 0..6. Missing days are treated as disabled (safe default). */
  weekly: WeeklyDaySchedule[];
  /** ISO dates (YYYY-MM-DD) the technician is entirely unavailable. Capped. */
  unavailableDates: string[];
  /** Free-form service area labels, e.g. "Khulna", "Dhanmondi". Capped. */
  serviceAreas: string[];
  /** IANA timezone identifier, e.g. "Asia/Dhaka". */
  timezone: string;
  updatedAt: Date;
}

export interface UserLocation {
  /** Approximate area/city label — never a precise address. */
  area?: string;
  /** Coordinates are stored only when explicitly consented to; never exposed publicly. */
  coordinates?: { lat: number; lng: number };
}

export const NOTIFICATION_TYPES = [
  "booking_requested",
  "booking_accepted",
  "booking_rejected",
  "booking_cancelled",
  "booking_started",
  "booking_completed",
  "payment_confirmed",
  "refund_requested",
  "refund_approved",
  "refund_rejected",
  "refund_succeeded",
  "refund_failed",
  "service_moderation",
  "application_reviewed",
  "admin_operational",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface AppNotification {
  /** Server-generated hex id (ObjectId) — used by mark-read endpoints. */
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Related booking for deep-linking, when applicable. */
  bookingId?: ObjectId;
  serviceId?: ObjectId;
  createdAt: Date;
  readAt?: Date | null;
}

export const COUPON_KINDS = ["fixed", "percent"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

export interface CouponDefinition {
  /** Normalized: trimmed, uppercase. */
  code: string;
  kind: CouponKind;
  /** percent: 1–100. fixed: major units in `currency`. */
  value: number;
  /** For fixed coupons: ISO 4217 currency the fixed amount is denominated in. Empty for percent coupons. */
  currency?: string;
  /** Minimum booking (final) amount in major units. 0 = no minimum. */
  minBookingAmount: number;
  /** Optional cap on the discount (percent coupons), major units. */
  maxDiscount?: number;
  startsAt: Date;
  expiresAt: Date;
  /** Total redemption cap across all customers. Undefined = unlimited. */
  globalLimit?: number;
  /** Per-customer redemption cap. Defaults to 1. */
  perCustomerLimit: number;
  /** Optional restriction to specific service categories. */
  categories?: string[];
  active: boolean;
  /** Atomic redemption counter — guarded by conditional update. */
  usageCount: number;
  createdAt: Date;
  createdBy: ObjectId;
}

/**
 * Admin-owned platform configuration embedded on the single Main Admin's
 * user document. Bounded (≤200 coupons). Only reachable by the designated
 * Main Admin; transfers with the hierarchy atomically.
 */
export interface AdminConfig {
  coupons: CouponDefinition[];
  createdAt?: Date;
  updatedAt?: Date;
}
