
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyCustomer } from "../middleware/verifyCustomer.js";
import { createBooking, listTechnicianBookings, acceptBooking, rejectBooking } from "../controllers/booking.controller.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";

const router = Router();

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/", verifyToken, verifyCustomer, createBooking);
router.get("/technician", verifyToken, verifyTechnician, listTechnicianBookings);
router.patch("/:id/accept", verifyToken, verifyTechnician, acceptBooking);
router.patch("/:id/reject", verifyToken, verifyTechnician, rejectBooking);

export default router;
