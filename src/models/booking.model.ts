
import type { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import type { ServiceCategory } from "./service.model.js";

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
  serviceCategory: ServiceCategory;
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
  createdAt: Date;
  updatedAt: Date;
}

// Document shape for inserts: the server assigns _id and timestamps.
export type BookingInsert = Omit<Booking, "_id" | "createdAt" | "updatedAt">;

export const getBookingsCollection = (): Collection<Booking> =>
  getDB().collection<Booking>(BOOKINGS_COLLECTION);
