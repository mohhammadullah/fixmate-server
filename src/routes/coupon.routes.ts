
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyCustomer } from "../middleware/verifyCustomer.js";
import { previewCoupon } from "../controllers/coupon.controller.js";

const router = Router();

// Customer-facing coupon preview for a completed, unpaid booking.
// NOTE: never used to charge — the checkout flow re-validates and
// re-computes the discount server-side.
router.post("/validate", verifyToken, verifyCustomer, previewCoupon);

export default router;
