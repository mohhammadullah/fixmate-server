
import { ObjectId } from "mongodb";
import {
  getBookingsCollection,
  ACTIVE_BOOKING_STATUSES,
  type Booking,
} from "../models/booking.model.js";
import {
  MAX_UNAVAILABLE_DATES,
  MAX_SERVICE_AREAS,
  type TechnicianAvailability,
  type WeeklyDaySchedule,
} from "../models/user-config.model.js";

// Explicit timezone strategy: all scheduling values are local wall-clock
// strings in a technician-configured IANA timezone. The server NEVER reads
// its own local timezone for validation: day-of-week is derived with
// Date.UTC ( noon trick, timezone-free), and "is in the past" comparisons
// are computed in the submitted timezone via Intl.

export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const SLOT_START_RE = /^([01]\d|2[0-3]):00$/;
export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const SLOT_DURATION_MINUTES = 60;
export const MAX_SCHEDULE_DAYS_AHEAD = 60;

export const DEFAULT_TIMEZONE = "Asia/Dhaka";

export const DEFAULT_WEEKLY_SCHEDULE: WeeklyDaySchedule[] = Array.from(
  { length: 7 },
  (_, day) => ({
    day,
    // Safe backward-compatible default: Mon–Sat 09:00–18:00 enabled.
    enabled: day !== 0,
    start: "09:00",
    end: "18:00",
    breaks: [],
  })
);

/** "YYYY-MM-DD" → UTC-noon Date, or null when the calendar date is invalid. */
export const parseLocalDate = (date: string): Date | null => {
  const match = DATE_RE.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
};

/** Day of week (0 = Sunday … 6 = Saturday), timezone-free. */
export const weekdayOf = (date: string): number | null => {
  const parsed = parseLocalDate(date);
  return parsed ? parsed.getUTCDay() : null;
};

export const minutesOf = (time: string): number | null => {
  const match = TIME_RE.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

export const isValidTimezone = (tz: string): boolean => {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  if (!/^[A-Za-z0-9_+\-\/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const addMinutes = (time: string, minutes: number): string | null => {
  const base = minutesOf(time);
  if (base === null) return null;
  const total = base + minutes;
  if (total >= 24 * 60) return null; // appointments never cross midnight
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const mins = String(total % 60).padStart(2, "0");
  return `${hours}:${mins}`;
};

/** Now as wall-clock parts in the given timezone. */
const nowPartsInTimezone = (timeZone: string): { date: string; time: string } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
  };
};

export interface SlotValidationError {
  message: string;
}

/** Validate the shape-level schedule fields; returns an error or null. */
export const validateScheduleShape = (
  input: { date: string; slotStart: string; timezone: string }
): SlotValidationError | null => {
  if (!parseLocalDate(input.date)) {
    return { message: "Schedule date is not a valid calendar date." };
  }
  if (!SLOT_START_RE.test(input.slotStart)) {
    return { message: "slotStart must be hourly (HH:00)." };
  }
  if (!isValidTimezone(input.timezone)) {
    return { message: "timezone is not a valid IANA timezone." };
  }
  return null;
};

/**
 * Validate that a technician's availability allows a slot. Returns null when
 * allowed, or an error object otherwise. Backward compatible: missing
 * availability => DEFAULT_WEEKLY_SCHEDULE, available, DEFAULT_TIMEZONE.
 */
export const validateTechnicianSlot = (
  availability: TechnicianAvailability | null | undefined,
  date: string,
  slotStart: string
): SlotValidationError | null => {
  const weekly = availability?.weekly?.length === 7
    ? availability.weekly
    : DEFAULT_WEEKLY_SCHEDULE;
  const status = availability?.status ?? "available";

  if (status === "busy") {
    return { message: "This technician is currently marked as busy." };
  }

  if ((availability?.unavailableDates ?? []).includes(date)) {
    return { message: "The technician is unavailable on this date." };
  }

  const weekday = weekdayOf(date);
  if (weekday === null) return { message: "Schedule date is invalid." };
  const day = weekly.find((entry) => entry.day === weekday);
  if (!day || !day.enabled) {
    return { message: "The technician does not work on this weekday." };
  }

  const start = minutesOf(slotStart);
  const end = start === null ? null : start + SLOT_DURATION_MINUTES;
  const workStart = minutesOf(day.start);
  const workEnd = minutesOf(day.end);
  if (start === null || end === null || workStart === null || workEnd === null) {
    return { message: "Technician working hours are misconfigured." };
  }
  if (workStart >= workEnd) {
    return { message: "Technician working hours are misconfigured." };
  }
  if (start < workStart || end > workEnd) {
    return { message: "The selected slot is outside the technician's working hours." };
  }
  for (const brk of day.breaks ?? []) {
    const brkStart = minutesOf(brk.start);
    const brkEnd = minutesOf(brk.end);
    if (brkStart === null || brkEnd === null) continue;
    // Overlap of [start, end) with [brkStart, brkEnd)?
    if (brkStart < end && start < brkEnd) {
      return { message: "The selected slot overlaps the technician's break." };
    }
  }
  return null;
};

/** Human-readable default timezone used across the app. */
export const getDefaultTimezone = (): string => DEFAULT_TIMEZONE;

export const clampUnavailableDates = (dates: string[]): string[] =>
  dates.slice(0, MAX_UNAVAILABLE_DATES);

export const clampServiceAreas = (areas: string[]): string[] =>
  areas.slice(0, MAX_SERVICE_AREAS);

/** Find an overlapping/duplicate booking for the technician in the slot. */
export const findConflictingBooking = async (
  technicianId: ObjectId,
  date: string,
  slotStart: string,
  excludeBookingId?: ObjectId
): Promise<Booking | null> => {
  // Fixed 60-minute aligned slots: two slots conflict iff they are the same
  // (date, slotStart) — this equality is what the unique partial index
  // backstops atomically.
  const conflict = await getBookingsCollection().findOne(
    {
      technicianId,
      status: { $in: [...ACTIVE_BOOKING_STATUSES] },
      "schedule.date": date,
      "schedule.slotStart": slotStart,
      ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
    },
    { projection: { _id: 1 } }
  );
  return conflict ?? null;
};

/** "Is this slot in the past?" — computed in the submitted timezone. */
export const isSlotInPast = (
  date: string,
  slotStart: string,
  timezone: string
): boolean => {
  const now = nowPartsInTimezone(timezone);
  if (date < now.date) return true;
  if (date === now.date && slotStart <= now.time) return true;
  return false;
};

/** Limit how far in the future a booking can be scheduled. */
export const isSlotTooFarAhead = (date: string, timezone: string): boolean => {
  const now = nowPartsInTimezone(timezone);
  const limit = new Date(Date.parse(`${now.date}T00:00:00Z`) + MAX_SCHEDULE_DAYS_AHEAD * 24 * 3600 * 1000);
  const limitStr = limit.toISOString().slice(0, 10);
  return date > limitStr;
};
