import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";
import { uploadImage, MAX_IMAGE_BYTES } from "../controllers/upload.controller.js";

const router = express.Router();

// Raw multipart bytes are parsed in the controller with native FormData.
// The limit is above the 5 MB per-file validation to leave room for headers.
router.post(
  "/image",
  verifyToken,
  verifyTechnician,
  express.raw({ type: "multipart/form-data", limit: MAX_IMAGE_BYTES + 1024 * 1024 }),
  uploadImage
);

export default router;
