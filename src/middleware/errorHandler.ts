
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";

// Body-parser errors (e.g. malformed JSON) arrive as an Error with a
// `status`/`statusCode` property. Everything else is a 500.
const getStatusCode = (error: unknown): number => {
  if (typeof error === "object" && error !== null) {
    const candidate =
      (error as { status?: unknown }).status ??
      (error as { statusCode?: unknown }).statusCode;
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate < 600
    ) {
      return candidate;
    }
  }
  return 500;
};

export const notFoundHandler = (
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
};

// Express 5 forwards rejected promises from async handlers here.
// Better Auth routes are mounted before this middleware, so auth errors
// are handled by Better Auth itself and never reach this handler.
export const errorHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = getStatusCode(error);

  if (env.isDevelopment) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, error);
  } else if (statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, error);
  }

  if (statusCode < 500) {
    const safeMessages: Record<number, string> = {
      400: "Bad request.",
      401: "Unauthorized.",
      403: "Forbidden.",
      404: "Not found.",
      408: "Request timeout.",
      413: "Payload too large.",
      415: "Unsupported media type.",
    };
    res.status(statusCode).json({
      success: false,
      message:
        env.isDevelopment && error instanceof Error && error.message
          ? error.message
          : safeMessages[statusCode] ?? "Bad request.",
    });
    return;
  }

  res.status(500).json({
    success: false,
    message: env.isProduction
      ? "Internal server error."
      : error instanceof Error
        ? error.message
        : "Internal server error.",
  });
};
