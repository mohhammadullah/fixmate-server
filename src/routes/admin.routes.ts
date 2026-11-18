import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";
import {
  getDashboardStats,
  listUsers,
  getUserById,
  updateUserRole,
  transferMainAdmin,
  listAllBookings,
  listServicesForAdmin,
  listPaymentsForAdmin,
} from "../controllers/admin.controller.js";
import { getAdminAnalytics } from "../controllers/admin-analytics.controller.js";
import { getAdminBooking } from "../controllers/admin-booking.controller.js";
import { listAdminRefunds, decideRefund } from "../controllers/refund.controller.js";
import {
  listCoupons,
  createCoupon,
  updateCoupon,
  disableCoupon,
} from "../controllers/coupon.controller.js";

const router = Router();

router.get("/dashboard/stats", verifyToken, verifyAdmin, getDashboardStats);

router.get("/users", verifyToken, verifyAdmin, listUsers);
router.get("/users/:id", verifyToken, verifyAdmin, getUserById);
router.patch("/users/:id/role", verifyToken, verifyAdmin, updateUserRole);
// Main Admin ownership handover — re-authenticated, transactional, Main Admin only.
router.post("/main-admin/transfer", verifyToken, verifyAdmin, transferMainAdmin);

// Admin analytics (full KPI dashboard, date-range filter).
router.get("/analytics", verifyToken, verifyAdmin, getAdminAnalytics);

router.get("/bookings", verifyToken, verifyAdmin, listAllBookings);
router.get("/bookings/:id", verifyToken, verifyAdmin, getAdminBooking);

// Admin service moderation queue (pending by default).
router.get("/services", verifyToken, verifyAdmin, listServicesForAdmin);

// Admin payments listing (read-only; statuses are owned by the Stripe webhook).
router.get("/payments", verifyToken, verifyAdmin, listPaymentsForAdmin);

// Refund moderation queue + decisions (admins; Main Admin hierarchy untouched).
router.get("/refunds", verifyToken, verifyAdmin, listAdminRefunds);
router.post("/refunds/:paymentId/:refundId/decide", verifyToken, verifyAdmin, decideRefund);

// Coupon administration — reads: any admin; writes: Main Admin only
// (enforced inside the handlers against the fresh DB role).
router.get("/coupons", verifyToken, verifyAdmin, listCoupons);
router.post("/coupons", verifyToken, verifyAdmin, createCoupon);
router.patch("/coupons/:code", verifyToken, verifyAdmin, updateCoupon);
router.delete("/coupons/:code", verifyToken, verifyAdmin, disableCoupon);

export default router;
