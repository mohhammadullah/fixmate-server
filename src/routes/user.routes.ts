import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { getMyProfile, updateMyProfile } from "../controllers/user.controller.js";

const router = Router();

// Both routes resolve identity exclusively from the verified JWT.
router.get("/me", verifyToken, getMyProfile);
router.patch("/me", verifyToken, updateMyProfile);

export default router;
