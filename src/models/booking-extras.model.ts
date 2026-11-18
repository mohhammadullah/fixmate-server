
import { ObjectId } from "mongodb";

/**
 * Embedded structures and subdocuments stored on the existing `bookings`
 * collection. No new application-owned collection is introduced.
 *
 * Bounds:
 * - timeline: capped at 100 entries (inserts trim with $slice)
 * - conversation.messages: capped at 200 entries
 * - schedule/timeline/invoice are subdocuments — no unbounded arrays beyond
 *   the two above, and booking documents stay far below the 16 MB limit.
 */

export const BOOKING_TIMELINE_TYPES = [
  "requested",
  "accepted",
  "rejected",
  "cancelled",
  "started",
  "completed",
  "payment_confirmed",
  "refunded",
  "schedule_changed",
] as const;
export type BookingTimelineType = (typeof BOOKING_TIMELINE_TYPES)[number];

export type TimelineActor = "customer" | "technician" | "admin" | "system";

export interface BookingTimelineEvent {
  type: BookingTimelineType;
  at: Date;
  by: TimelineActor;
  /** Safe short note for display, e.g. "final amount $150". Never client-supplied raw input without sanitization. */
  note?: string;
}

export interface BookingSchedule {
  /** Local wall-clock date "YYYY-MM-DD" in `timezone`. */
  date: string;
  /** "HH:MM", strictly on the hour (fixed 60-minute slots). */
  slotStart: string;
  /** "HH:MM" slot end (= slotStart + 60 minutes, same-day guaranteed by validation). */
  slotEnd: string;
  /** Duration in minutes; fixed at 60 by the current implementation. */
  durationMinutes: number;
  /** IANA timezone, e.g. "Asia/Dhaka". Never assume the server's timezone. */
  timezone: string;
}

export const CHAT_MESSAGE_MAX_LENGTH = 500;
export const CHAT_MESSAGES_CAP = 200;
export const CHAT_PAGE_SIZE = 20;

export interface ChatMessage {
  /** Server-generated hex id (ObjectId). */
  id: string;
  senderId: ObjectId;
  senderRole: "customer" | "technician";
  text: string;
  createdAt: Date;
  /** Set when the non-sender participant reads this message. */
  readAt?: Date | null;
}

export interface BookingConversation {
  messages: ChatMessage[];
}

export interface BookingInvoice {
  /** Deterministic per booking: INV-YYYYMM-<8 hex tail of booking id>. */
  number: string;
  issuedAt: Date;
  currency: string;
  /** Major units — service amount (final amount), snapshot at issue time. */
  serviceAmount: number;
  /** Major units. 0 when no coupon was applied. */
  discountAmount: number;
  discountCode?: string;
  /** Major units. 0 unless a platform tax is configured; see env TAX_RATE. */
  taxAmount: number;
  /** Major units. = serviceAmount - discountAmount + taxAmount (never negative). */
  totalAmount: number;
  paymentStatus: "unpaid" | "paid" | "refunded" | "partially_refunded";
  paidAt?: Date;
  /** Safe reference (Stripe session id) — full reference lives on the payment doc. */
  paymentReference?: string;
  // Snapshots for the printed/customer-facing invoice:
  customerName: string;
  customerEmail: string;
  technicianName: string;
  serviceTitle: string;
  serviceCategory: string;
  serviceLocation: string;
  bookingReference: string;
}

export interface AppliedCoupon {
  code: string;
  kind: "fixed" | "percent";
  value: number;
  /** Major units discounted from the payable amount (snapshot at checkout). */
  discountAmount: number;
  currency: string;
  appliedAt: Date;
}
