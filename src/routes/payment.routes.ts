
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyCustomer } from "../middleware/verifyCustomer.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";
import {
  createCheckoutSession,
  handleStripeWebhook,
  listMyPayments,
  listTechnicianPayments,
} from "../controllers/payment.controller.js";
import { requestRefund } from "../controllers/refund.controller.js";

const router = Router();

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/checkout-session", verifyToken, verifyCustomer, createCheckoutSession);
router.get("/my", verifyToken, verifyCustomer, listMyPayments);
// Technician payment history: settlement visibility for the caller's own
// completed bookings. Identity comes from the verified JWT; the role gate
// is verifyTechnician. Customers and admins cannot reach it.
router.get("/technician", verifyToken, verifyTechnician, listTechnicianPayments);
router.post("/:paymentId/refunds", verifyToken, verifyCustomer, requestRefund);

// No auth middleware: the Stripe signature is verified against the raw
// request body (mounted ahead of express.json() in app.ts).
router.post("/webhook", handleStripeWebhook);

export default router;
