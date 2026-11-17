
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";
import { createService, updateService, deleteService } from "../controllers/service.controller.js";

const router = Router();

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/", verifyToken, verifyTechnician, createService);
router.patch("/:id", verifyToken, verifyTechnician, updateService);
router.delete("/:id", verifyToken, verifyTechnician, deleteService);

export default router;
