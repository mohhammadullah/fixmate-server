
import { Router } from "express";
import {
  verifyToken,
  type AuthenticatedRequest,
} from "../middleware/verifyToken.js";
import { verifyCustomer } from "../middleware/verifyCustomer.js";
import { verifyTechnician } from "../middleware/verifyTechnician.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";

const router = Router();

router.get("/public", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Public API is working!",
  });
});

router.get(
  "/protected",
  verifyToken,
  (req: AuthenticatedRequest, res) => {
    res.status(200).json({
      success: true,
      message: "You are authenticated!",
      user: req.user,
    });
  }
);

router.get(
  "/customer",
  verifyToken,
  verifyCustomer,
  (req: AuthenticatedRequest, res) => {
    res.status(200).json({
      success: true,
      message: "Welcome Customer!",
      user: req.user,
    });
  }
);

router.get(
  "/technician",
  verifyToken,
  verifyTechnician,
  (req: AuthenticatedRequest, res) => {
    res.status(200).json({
      success: true,
      message: "Welcome Technician!",
      user: req.user,
    });
  }
);

router.get(
  "/admin",
  verifyToken,
  verifyAdmin,
  (req: AuthenticatedRequest, res) => {
    res.status(200).json({
      success: true,
      message: "Welcome Admin!",
      user: req.user,
    });
  }
);

export default router;
