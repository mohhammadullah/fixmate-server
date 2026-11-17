
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyCustomer } from "../middleware/verifyCustomer.js";
import { createBooking } from "../controllers/booking.controller.js";

const router = Router();

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/", verifyToken, verifyCustomer, createBooking);

export default router;
