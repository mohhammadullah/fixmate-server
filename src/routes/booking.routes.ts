
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyCustomer } from "../middleware/verifyCustomer.js";
import { createBooking, listTechnicianBookings, acceptBooking, rejectBooking, updateBookingStatus, listMyBookings, cancelBooking } from "../controllers/booking.controller.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";

const router = Router();

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/", verifyToken, verifyCustomer, createBooking);
router.get("/my", verifyToken, verifyCustomer, listMyBookings);
router.get("/technician", verifyToken, verifyTechnician, listTechnicianBookings);
router.patch("/:id/accept", verifyToken, verifyTechnician, acceptBooking);
router.patch("/:id/reject", verifyToken, verifyTechnician, rejectBooking);
router.patch("/:id/status", verifyToken, verifyTechnician, updateBookingStatus);
router.patch("/:id/cancel", verifyToken, verifyCustomer, cancelBooking);

export default router;
