
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";
import { createService, updateService, deleteService, approveService, rejectService, listServices, listMyServices, getServiceDetails, listNearbyServices } from "../controllers/service.controller.js";
import { getServiceAvailabilityPublic } from "../controllers/availability.controller.js";

const router = Router();

// GET / is intentionally public: only approved + available services are exposed.
router.get("/", listServices);
// Static /my must be registered before the dynamic /:id routes below so it
// can never be shadowed by them.
router.get("/my", verifyToken, verifyTechnician, listMyServices);
// Static /nearby must be registered before the dynamic /:id routes below so
// it can never be shadowed by them.
router.get("/nearby", listNearbyServices);

// Public service details. Registered after the static /my route so the
// dynamic /:id can never shadow it.
router.get("/:id/availability", verifyToken, getServiceAvailabilityPublic);
router.get("/:id", getServiceDetails);

// Middleware order matters: JWT first, then role. Never trust body roles.
router.post("/", verifyToken, verifyTechnician, createService);
router.patch("/:id", verifyToken, verifyTechnician, updateService);
router.delete("/:id", verifyToken, verifyTechnician, deleteService);
router.patch("/:id/approve", verifyToken, verifyAdmin, approveService);
router.patch("/:id/reject", verifyToken, verifyAdmin, rejectService);

export default router;
