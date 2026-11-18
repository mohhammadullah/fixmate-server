
import type { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import type { AnyServiceCategory } from "./service.model.js";
import type {
  BookingSchedule,
  BookingTimelineEvent,
  BookingConversation,
  BookingInvoice,
  AppliedCoupon,
} from "./booking-extras.model.js";

export const BOOKINGS_COLLECTION = "bookings";

export const BOOKING_STATUSES = [
  "requested",
  "accepted",
  "in-progress",
  "completed",
  "rejected",
  "cancelled",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

// Statuses that count as "active" for duplicate-booking protection. Any
// booking outside this set (completed, rejected, cancelled) does not block
// the customer from booking the same service again.
export const ACTIVE_BOOKING_STATUSES = [
  "requested",
  "accepted",
  "in-progress",
] as const satisfies readonly BookingStatus[];

export type ActiveBookingStatus = (typeof ACTIVE_BOOKING_STATUSES)[number];

export const PAYMENT_STATUSES = ["unpaid", "paid", "refunded"] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// A customer review of a completed booking. Reviews are stored as a
// subdocument on the booking itself — no separate reviews collection exists.
// Rating is a whole number from 1 to 5; the comment is validated by
// createReviewSchema (see validators/review.validator.ts).
export interface BookingReview {
  rating: number;
  comment: string;
  createdAt: Date;
}

export interface Booking {
  _id: ObjectId;
  serviceId: ObjectId;
  customerId: ObjectId;
  technicianId: ObjectId;
  // Snapshots taken at booking time from the server-side user profile and
  // the service document; never taken from the request body.
  customerName: string;
  customerEmail: string;
  technicianName: string;
  technicianEmail: string;
  serviceTitle: string;
  serviceCategory: AnyServiceCategory;
  serviceLocation: string;
  serviceImage: string;
  hourlyRate: number;
  securityDeposit: number;
  // Customer-supplied job details.
  problemDescription: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  // Settled only when the job is completed (final price agreed after work);
  // absent at creation time.
  finalAmount?: number;
  // Customer review for this booking. Absent until the owning customer
  // submits one; at most one review exists per booking. Only completed
  // bookings may carry a review.
  review?: BookingReview;
  // --- Scheduling / tracking / messaging / invoicing extensions ---
  // All optional: existing bookings without them remain valid (backward
  // compatible). See models/booking-extras.model.ts for bounds.
  schedule?: BookingSchedule;
  timeline?: BookingTimelineEvent[];
  conversation?: BookingConversation;
  invoice?: BookingInvoice;
  appliedCoupon?: AppliedCoupon;
  createdAt: Date;
  updatedAt: Date;
}

// Document shape for inserts: the server assigns _id and timestamps.
export type BookingInsert = Omit<Booking, "_id" | "createdAt" | "updatedAt">;

export const getBookingsCollection = (): Collection<Booking> =>
  getDB().collection<Booking>(BOOKINGS_COLLECTION);
