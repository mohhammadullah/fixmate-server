
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";
import { createService, updateService, deleteService, approveService, rejectService } from "../controllers/service.controller.js";

const router = Router();

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/", verifyToken, verifyTechnician, createService);
router.patch("/:id", verifyToken, verifyTechnician, updateService);
router.delete("/:id", verifyToken, verifyTechnician, deleteService);
router.patch("/:id/approve", verifyToken, verifyAdmin, approveService);
router.patch("/:id/reject", verifyToken, verifyAdmin, rejectService);

export default router;
