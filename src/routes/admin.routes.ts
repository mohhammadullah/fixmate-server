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

const router = Router();

router.get("/dashboard/stats", verifyToken, verifyAdmin, getDashboardStats);

router.get("/users", verifyToken, verifyAdmin, listUsers);
router.get("/users/:id", verifyToken, verifyAdmin, getUserById);
router.patch("/users/:id/role", verifyToken, verifyAdmin, updateUserRole);
// Main Admin ownership handover — re-authenticated, transactional, Main Admin only.
router.post("/main-admin/transfer", verifyToken, verifyAdmin, transferMainAdmin);

router.get("/bookings", verifyToken, verifyAdmin, listAllBookings);

// Admin service moderation queue (pending by default).
router.get("/services", verifyToken, verifyAdmin, listServicesForAdmin);

// Admin payments listing (read-only; statuses are owned by the Stripe webhook).
router.get("/payments", verifyToken, verifyAdmin, listPaymentsForAdmin);

export default router;
