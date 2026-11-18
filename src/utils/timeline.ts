
import { ObjectId, type UpdateFilter } from "mongodb";
import {
  getBookingsCollection,
  type Booking,
} from "../models/booking.model.js";
import type {
  BookingTimelineEvent,
  BookingTimelineType,
  TimelineActor,
} from "../models/booking-extras.model.js";

// Bounded server-written timeline: at most 100 entries per booking.
export const TIMELINE_CAP = 100;

const sanitizeNote = (note: string | undefined): string | undefined => {
  if (typeof note !== "string") return undefined;
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : undefined;
};

/**
 * Append a timeline event to a booking — ONLY callable after a successful
 * authorized backend operation. Uses a single atomic conditional update;
 * the $each + $slice keeps the array bounded at TIMELINE_CAP.
 *
 * Never called from request middleware for unverified events, and never
 * built from raw client input beyond the sanitized `note`.
 */
export const appendBookingTimeline = async (
  bookingId: ObjectId,
  type: BookingTimelineType,
  by: TimelineActor,
  note?: string
): Promise<void> => {
  const event: BookingTimelineEvent = {
    type,
    at: new Date(),
    by,
    ...(sanitizeNote(note) !== undefined ? { note: sanitizeNote(note) } : {}),
  };
  const update: UpdateFilter<Booking> = {
    $push: {
      timeline: { $each: [event], $slice: -TIMELINE_CAP },
    },
  };
  await getBookingsCollection().updateOne({ _id: bookingId }, update);
};

/** Safe public view of a timeline event. */
export interface PublicTimelineEvent {
  type: BookingTimelineType;
  at: string;
  by: TimelineActor;
  note?: string;
}

export const toPublicTimeline = (
  timeline: Booking["timeline"]
): PublicTimelineEvent[] =>
  (timeline ?? []).map((event) => ({
    type: event.type,
    at: event.at instanceof Date ? event.at.toISOString() : String(event.at),
    by: event.by,
    ...(event.note ? { note: event.note } : {}),
  }));
