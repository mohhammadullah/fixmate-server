
import { Router } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyCustomer } from "../middleware/verifyCustomer.js";
import { createBooking, listTechnicianBookings, acceptBooking, rejectBooking, updateBookingStatus, listMyBookings, cancelBooking, getBookingDetails, submitReview } from "../controllers/booking.controller.js";
import { getBookingInvoice } from "../controllers/invoice.controller.js";
import { listChatMessages, sendChatMessage, markChatRead } from "../controllers/chat.controller.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";

const router = Router();

// Chat sender limiter — per instance, keyed by subject (falls back to IP).
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const user = (req as { user?: { id?: string } }).user;
    // IPv6-safe fallback: never raw req.ip — use the library helper.
    return user?.id ?? ipKeyGenerator(req.ip ?? "");
  },
  message: {
    success: false,
    message: "You are sending messages too quickly. Please slow down.",
  },
});

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/", verifyToken, verifyCustomer, createBooking);
router.get("/my", verifyToken, verifyCustomer, listMyBookings);
router.get("/technician", verifyToken, verifyTechnician, listTechnicianBookings);
router.patch("/:id/accept", verifyToken, verifyTechnician, acceptBooking);
router.patch("/:id/reject", verifyToken, verifyTechnician, rejectBooking);
router.patch("/:id/status", verifyToken, verifyTechnician, updateBookingStatus);
router.patch("/:id/cancel", verifyToken, verifyCustomer, cancelBooking);
router.post("/:id/review", verifyToken, verifyCustomer, submitReview);
router.get("/:id/invoice", verifyToken, getBookingInvoice);
router.get("/:id/chat", verifyToken, listChatMessages);
router.post("/:id/chat", verifyToken, chatLimiter, sendChatMessage);
router.post("/:id/chat/read", verifyToken, markChatRead);
// Registered after the static GET routes (/my, /technician) so it never
// shadows them.
router.get("/:id", verifyToken, verifyCustomer, getBookingDetails);

export default router;
