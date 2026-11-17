import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";
import {
  getDashboardStats,
  listUsers,
  getUserById,
  updateUserRole,
  listAllBookings,
} from "../controllers/admin.controller.js";

const router = Router();

// Every route is guarded by JWT verification followed by the admin role guard.
router.get("/dashboard/stats", verifyToken, verifyAdmin, getDashboardStats);

router.get("/users", verifyToken, verifyAdmin, listUsers);
router.get("/users/:id", verifyToken, verifyAdmin, getUserById);
router.patch("/users/:id/role", verifyToken, verifyAdmin, updateUserRole);

router.get("/bookings", verifyToken, verifyAdmin, listAllBookings);

export default router;
