
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";
import {
  getMyAvailability,
  upsertMyAvailability,
  getTechnicianAvailabilityPublic,
} from "../controllers/availability.controller.js";

const router = Router();

// Technician self-service availability management.
router.get("/users/me/availability", verifyToken, verifyTechnician, getMyAvailability);
router.put("/users/me/availability", verifyToken, verifyTechnician, upsertMyAvailability);

// Public working-pattern read for booking UX (any authenticated user).
router.get("/technicians/:id/availability", verifyToken, getTechnicianAvailabilityPublic);

export default router;
