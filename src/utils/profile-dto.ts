import type { UserWithApplication } from "../models/technician-application.model.js";

// Safe self-profile DTO shared by the profile endpoints. Never exposes
// password hashes, provider accounts, sessions, tokens or internal review
// data. `image` is included: it is the own-account avatar URL (the same value
// the public review endpoint already projects), never a credential.

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const dateOrNull = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;

/** Mongo projection for the fields the DTO reads. */
export const PROFILE_PROJECTION = {
  name: 1,
  email: 1,
  role: 1,
  phone: 1,
  area: 1,
  bio: 1,
  image: 1,
  createdAt: 1,
  updatedAt: 1,
  "technicianApplication.status": 1,
  location: 1,
} as const;

export const toProfileDto = (user: UserWithApplication) => ({
  id: user._id.toHexString(),
  name: stringOrNull(user.name),
  email: stringOrNull(user.email),
  role: stringOrNull(user.role) ?? "customer",
  phone: stringOrNull(user.phone),
  area: stringOrNull(user.area),
  bio: stringOrNull(user.bio),
  // Only accept http(s) URLs defensively — the value is server-controlled
  // (ImgBB) but documents may predate this field entirely.
  image:
    typeof user.image === "string" && /^https?:\/\//i.test(user.image.trim())
      ? user.image.trim()
      : null,
  createdAt: dateOrNull(user.createdAt),
  updatedAt: dateOrNull(user.updatedAt),
  // Only the status is surfaced — no reviewer, reason or submitted details.
  technicianApplicationStatus: user.technicianApplication?.status ?? null,
  // Coordinates are intentionally NOT returned; the DTO only reveals whether
  // the user consented to location matching.
  hasLocation: Boolean(
    user.location && typeof user.location === "object"
  ),
});

export type ProfileDto = ReturnType<typeof toProfileDto>;
