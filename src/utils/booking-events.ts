
import { ObjectId } from "mongodb";
import type { Booking } from "../models/booking.model.js";
import type {
  BookingTimelineType,
  TimelineActor,
} from "../models/booking-extras.model.js";
import { appendBookingTimeline } from "./timeline.js";
import { notifyUsers, adminUserIds } from "./notifications.js";
import { type NotificationType } from "../models/user-config.model.js";

/**
 * Booking lifecycle fan-out: server-written timeline event + targeted
 * notifications, both fired only after a successful authorized mutation.
 * Failures here are logged but never break the primary operation — the
 * state transition has already been committed by the caller.
 */

const safeNote = (note?: string): string | undefined => {
  if (typeof note !== "string") return undefined;
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : undefined;
};

const eventToNotification = (
  type: BookingTimelineType,
  booking: Booking
): { type: NotificationType; title: string; body: string } | null => {
  const service = booking.serviceTitle || "your repair";
  switch (type) {
    case "requested":
      return {
        type: "booking_requested",
        title: "New booking request",
        body: `${booking.customerName} requested "${service}".`,
      };
    case "accepted":
      return {
        type: "booking_accepted",
        title: "Booking accepted",
        body: `Your booking for "${service}" was accepted by the technician.`,
      };
    case "rejected":
      return {
        type: "booking_rejected",
        title: "Booking declined",
        body: `Your booking for "${service}" was declined by the technician.`,
      };
    case "cancelled":
      return {
        type: "booking_cancelled",
        title: "Booking cancelled",
        body: `The booking for "${service}" was cancelled.`,
      };
    case "started":
      return {
        type: "booking_started",
        title: "Repair started",
        body: `The technician started working on "${service}".`,
      };
    case "completed":
      return {
        type: "booking_completed",
        title: "Repair completed",
        body: `The technician marked "${service}" as completed.`,
      };
    case "payment_confirmed":
      return {
        type: "payment_confirmed",
        title: "Payment confirmed",
        body: `Payment for "${service}" was received.`,
      };
    case "refunded":
      return {
        type: "refund_succeeded",
        title: "Refund processed",
        body: `Your refund for "${service}" was processed.`,
      };
    default:
      return null;
  }
};

/**
 * Emit a booking lifecycle event: appends the timeline entry and notifies
 * the *appropriate* side(s):
 *  - requested / cancelled        → technician (+ customer mirror for cancelled)
 *  - accepted/rejected/started/completed → customer
 *  - payment_confirmed            → customer (+technician)
 */
export const emitBookingEvent = async (
  booking: Booking,
  type: BookingTimelineType,
  by: TimelineActor,
  note?: string
): Promise<void> => {
  try {
    await appendBookingTimeline(booking._id, type, by, safeNote(note));
  } catch (error) {
    console.error(`Failed to append ${type} timeline for booking ${booking._id.toHexString()}:`, error);
  }

  const notification = eventToNotification(type, booking);
  if (!notification) return;

  try {
    const recipients: ObjectId[] = [];
    const customer = booking.customerId;
    const technician = booking.technicianId;

    switch (type) {
      case "requested":
        recipients.push(technician);
        break;
      case "accepted":
      case "rejected":
      case "started":
      case "completed":
        recipients.push(customer);
        break;
      case "cancelled":
        recipients.push(technician);
        recipients.push(customer);
        break;
      case "payment_confirmed":
        recipients.push(customer, technician);
        break;
      case "refunded":
        recipients.push(customer);
        break;
      default:
        break;
    }

    await notifyUsers(recipients, {
      ...notification,
      bookingId: booking._id,
    });
  } catch (error) {
    console.error(`Failed to notify for ${type} event on booking ${booking._id.toHexString()}:`, error);
  }
};

/** Notify all admins (best effort). */
export const notifyAdmins = async (
  input: {
    type: NotificationType;
    title: string;
    body: string;
    bookingId?: ObjectId;
    serviceId?: ObjectId;
  }
): Promise<void> => {
  try {
    const admins = await adminUserIds();
    if (admins.length === 0) return;
    await notifyUsers(admins, input);
  } catch (error) {
    console.error("Failed to notify admins:", error);
  }
};
