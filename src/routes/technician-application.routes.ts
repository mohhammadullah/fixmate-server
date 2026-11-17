import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyCustomer } from "../middleware/verifyCustomer.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";
import {
  submitApplication,
  getMyApplication,
  listApplications,
  reviewApplication,
} from "../controllers/technician-application.controller.js";

const router = Router();

// Static /my is registered before nothing dynamic here, but keep the order
// explicit for consistency with the other route modules.
router.post("/", verifyToken, verifyCustomer, submitApplication);
router.get("/my", verifyToken, getMyApplication);
router.get("/", verifyToken, verifyAdmin, listApplications);
router.patch("/:userId/review", verifyToken, verifyAdmin, reviewApplication);

export default router;
