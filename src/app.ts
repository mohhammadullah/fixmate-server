
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { toNodeHandler } from "better-auth/node";

import testRoutes from "./routes/test.routes.js";
import serviceRoutes from "./routes/service.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import technicianApplicationRoutes from "./routes/technician-application.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import userRoutes from "./routes/user.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { env } from "./config/env.js";
import type { Auth } from "./config/auth.js";

export const createApp = (auth: Auth) => {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet());

  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    })
  );

  // Throttle authentication endpoints against brute-force/credential
  // stuffing. Generous enough for normal development and test usage.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests, please try again later.",
    },
  });

  // Better Auth handler MUST be mounted before express.json() so it can
  // read the raw request body itself. Express 5 requires a named wildcard
  // ({*any}) — a bare "*" is no longer valid path-to-regexp syntax.
  app.use("/api/auth", authLimiter);
  app.all("/api/auth/{*any}", toNodeHandler(auth));

  // The Stripe webhook must see the raw request body for signature
  // verification. Mounted before express.json() so every other route keeps
  // normal JSON parsing; express.json() skips this path because the raw
  // parser has already consumed the body.
  app.use(
    "/api/payments/webhook",
    express.raw({ type: "application/json", limit: "100kb" })
  );

  app.use(express.json({ limit: "100kb" }));

  app.get("/", (_req, res) => {
    res.json({
      success: true,
      message: "FixMate API is running!",
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      success: true,
      message: "FixMate server is healthy!",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/test", testRoutes);
  app.use("/api/services", serviceRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/technician-applications", technicianApplicationRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/uploads", uploadRoutes);
  app.use("/api/payments", paymentRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
