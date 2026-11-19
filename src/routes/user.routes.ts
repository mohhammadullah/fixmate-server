import express from "express";
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { getMyProfile, updateMyProfile } from "../controllers/user.controller.js";
import { updateMyProfileImage, removeMyProfileImage } from "../controllers/profile-image.controller.js";
import { MAX_IMAGE_BYTES } from "../utils/image-upload.js";

const router = Router();

// Both routes resolve identity exclusively from the verified JWT.
router.get("/me", verifyToken, getMyProfile);
router.patch("/me", verifyToken, updateMyProfile);

// Profile image for the authenticated user — every role (customer,
// technician, admin, Main Admin). Raw multipart bytes are parsed in the
// controller with native FormData. The limit is above the 5 MB per-file
// validation to leave room for multipart headers and fields.
router.post(
  "/me/image",
  verifyToken,
  express.raw({ type: "multipart/form-data", limit: MAX_IMAGE_BYTES + 1024 * 1024 }),
  updateMyProfileImage
);
router.delete("/me/image", verifyToken, removeMyProfileImage);

export default router;
