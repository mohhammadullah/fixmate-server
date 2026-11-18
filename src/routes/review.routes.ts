
import { Router } from "express";
import { getLatestReviews } from "../controllers/review.controller.js";

const router = Router();

// Public endpoint — no authentication. Returns the latest real customer
// reviews (max 6) with privacy-safe DTOs only.
router.get("/", getLatestReviews);

export default router;
