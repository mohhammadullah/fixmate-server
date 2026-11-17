
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";
import { createService } from "../controllers/service.controller.js";

const router = Router();

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/", verifyToken, verifyTechnician, createService);

export default router;
