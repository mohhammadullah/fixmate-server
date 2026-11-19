import type { Response } from "express";
import { ObjectId } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getUsersCollection } from "../models/technician-application.model.js";
import { updateProfileSchema } from "../validators/user.validator.js";
import { PROFILE_PROJECTION, toProfileDto } from "../utils/profile-dto.js";

const OBJECT_ID_HEX_REGEX = /^[0-9a-fA-F]{24}$/;
export const parseUserId = (raw: unknown): ObjectId | null =>
  typeof raw === "string" && OBJECT_ID_HEX_REGEX.test(raw) ? new ObjectId(raw) : null;

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
    { projection: { ...PROFILE_PROJECTION } }
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

  const { name, phone, area, bio, location } = parsed.data;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) set.name = name;
  // Empty strings are allowed to clear optional profile fields on the model;
  // the safe DTO renders them as null.
  if (phone !== undefined) set.phone = phone;
  if (area !== undefined) set.area = area;
  if (bio !== undefined) set.bio = bio;
  if (location !== undefined) {
    const cleaned: { area?: string; coordinates?: { lat: number; lng: number } } = {};
    if (location.area !== undefined) {
      cleaned.area = location.area.trim();
    }
    if (location.coordinates !== undefined) {
      cleaned.coordinates = {
        lat: Math.round(location.coordinates.lat * 1e5) / 1e5,
        lng: Math.round(location.coordinates.lng * 1e5) / 1e5,
      };
    }
    set.location = cleaned;
  }

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
