
import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./verifyToken.js";

export const verifyCustomer = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== "customer") {
    res.status(403).json({
      success: false,
      message: "Customer access only.",
    });
    return;
  }

  next();
};
