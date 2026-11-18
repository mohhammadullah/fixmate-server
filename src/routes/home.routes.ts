
import { Router } from "express";
import { getHomeSummary, getPopularServices } from "../controllers/home.controller.js";

const router = Router();

// Public endpoint — no authentication. Privacy-safe aggregate stats and
// recent booking activity for the homepage hero.
router.get("/summary", getHomeSummary);

// Public endpoint — no authentication. Privacy-safe aggregate ranking of
// service categories by genuine customer reviews (homepage Popular Services).
router.get("/popular-services", getPopularServices);

export default router;
