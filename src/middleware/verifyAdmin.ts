
import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./verifyToken.js";

export const verifyAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== "admin") {
    res.status(403).json({
      success: false,
      message: "Admin access only.",
    });
    return;
  }

  next();
};
