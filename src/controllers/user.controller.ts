import type { Response } from "express";
import { ObjectId } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getUsersCollection, type UserWithApplication } from "../models/technician-application.model.js";
import { updateProfileSchema } from "../validators/user.validator.js";

const OBJECT_ID_HEX_REGEX = /^[0-9a-fA-F]{24}$/;
const parseUserId = (raw: unknown): ObjectId | null =>
  typeof raw === "string" && OBJECT_ID_HEX_REGEX.test(raw) ? new ObjectId(raw) : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const dateOrNull = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;

/** Safe self-profile DTO. Never exposes password hashes, provider accounts,
 *  sessions, tokens or internal review data. */
const toProfileDto = (user: UserWithApplication) => ({
  id: user._id.toHexString(),
  name: stringOrNull(user.name),
  email: stringOrNull(user.email),
  role: stringOrNull(user.role) ?? "customer",
  phone: stringOrNull(user.phone),
  area: stringOrNull(user.area),
  bio: stringOrNull(user.bio),
  createdAt: dateOrNull(user.createdAt),
  updatedAt: dateOrNull(user.updatedAt),
  // Only the status is surfaced — no reviewer, reason or submitted details.
  technicianApplicationStatus: user.technicianApplication?.status ?? null,
});

// GET /api/users/me — any authenticated user, identified only by JWT.
export const getMyProfile = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  const userId = parseUserId(req.user.id);
  if (!userId) {
    res.status(401).json({ success: false, message: "Invalid token payload." });
    return;
  }
  const user = await getUsersCollection().findOne(
    { _id: userId },
    {
      projection: {
        name: 1, email: 1, role: 1, phone: 1, area: 1, bio: 1,
        createdAt: 1, updatedAt: 1, "technicianApplication.status": 1,
      },
    }
  );
  if (!user) {
    res.status(404).json({ success: false, message: "Account not found." });
    return;
  }
  res.status(200).json({ success: true, data: toProfileDto(user) });
};

// PATCH /api/users/me — strict editable fields only. Role, email and the
// application subdocument can never be modified through this endpoint.
export const updateMyProfile = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  const userId = parseUserId(req.user.id);
  if (!userId) {
    res.status(401).json({ success: false, message: "Invalid token payload." });
    return;
  }

  const parsed = updateProfileSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const { name, phone, area, bio } = parsed.data;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) set.name = name;
  // Empty strings are allowed to clear optional profile fields on the model;
  // the safe DTO renders them as null.
  if (phone !== undefined) set.phone = phone;
  if (area !== undefined) set.area = area;
  if (bio !== undefined) set.bio = bio;

  const updated = await getUsersCollection().findOneAndUpdate(
    { _id: userId },
    { $set: set },
    { returnDocument: "after" }
  );
  if (!updated) {
    res.status(404).json({ success: false, message: "Account not found." });
    return;
  }

  res.status(200).json({
    success: true,
    message: "Profile updated successfully.",
    data: toProfileDto(updated),
  });
};
