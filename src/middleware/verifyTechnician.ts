
import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./verifyToken.js";

export const verifyTechnician = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== "technician") {
    res.status(403).json({
      success: false,
      message: "Technician access only.",
    });
    return;
  }

  next();
};
