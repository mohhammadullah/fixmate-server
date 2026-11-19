import type { Response } from "express";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getUsersCollection } from "../models/technician-application.model.js";
import { parseImageUpload, uploadImageToHost } from "../utils/image-upload.js";
import { toProfileDto } from "../utils/profile-dto.js";
import { parseUserId } from "./user.controller.js";

// POST /api/users/me/image — any authenticated user (customer, technician,
// admin, Main Admin) replaces their own profile image. Identity comes only
// from the verified JWT — there is no user id in the URL, query or body, so
// one account can never write to another's record. The file is validated
// (JPEG/PNG/WebP, ≤5 MB, magic bytes) and streamed to ImgBB server-side; only
// the resulting hosted URL is stored on the Better Auth `user` document.
export const updateMyProfileImage = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!env.IMGBB_API_KEY) {
    res.status(503).json({ success: false, message: "Image uploads aren't configured on this server yet." });
    return;
  }
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  const userId = parseUserId(req.user.id);
  if (!userId) {
    res.status(401).json({ success: false, message: "Invalid token payload." });
    return;
  }

  const parsed = await parseImageUpload(req);
  if (!parsed.ok) {
    res.status(parsed.status).json({ success: false, message: parsed.message });
    return;
  }

  const uploaded = await uploadImageToHost(parsed.value, "profile");
  if (!uploaded.ok) {
    res.status(uploaded.status).json({ success: false, message: uploaded.message });
    return;
  }

  // `$set` only touches the image and updatedAt — role, email, verification
  // status, isMainAdmin and every other protected field are untouchable here.
  const updated = await getUsersCollection().findOneAndUpdate(
    { _id: userId },
    { $set: { image: uploaded.url, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    res.status(404).json({ success: false, message: "Account not found." });
    return;
  }

  res.status(200).json({
    success: true,
    message: "Profile image updated.",
    data: toProfileDto(updated),
  });
};

// DELETE /api/users/me/image — clear the authenticated user's own profile
// image. Idempotent: removing an already-empty image still succeeds. No
// image is deleted from the host (ImgBB URLs are immutable and may be shared
// elsewhere); only the reference on the user document is cleared.
export const removeMyProfileImage = async (
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

  const updated = await getUsersCollection().findOneAndUpdate(
    { _id: userId },
    { $set: { image: null, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    res.status(404).json({ success: false, message: "Account not found." });
    return;
  }

  res.status(200).json({
    success: true,
    message: "Profile image removed.",
    data: toProfileDto(updated),
  });
};
