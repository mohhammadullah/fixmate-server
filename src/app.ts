
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
import reviewRoutes from "./routes/review.routes.js";
import homeRoutes from "./routes/home.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import availabilityRoutes from "./routes/availability.routes.js";
import couponRoutes from "./routes/coupon.routes.js";
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

  // NOTE: Better Auth owns rate limiting for /api/auth (see
  // src/config/auth.ts): explicit, path-aware rules with environment-aware
  // budgets. A second Express limiter here would double-count every auth
  // request — Better Auth runs its check in the request phase before this
  // middleware would ever see the response.

  // Broad ceiling for non-auth API traffic: normal browser usage never
  // approaches it, abuse does. Development/test gets a generous budget
  // because all local traffic shares 127.0.0.1; production stays tight.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.isProduction ? 600 : 6000,
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
  // Rate limiting happens inside Better Auth, so /api/auth never reaches
  // the general apiLimiter below.
  app.all("/api/auth/{*any}", toNodeHandler(auth));

  // The Stripe webhook must see the raw request body for signature
  // verification. Mounted before express.json() so every other route keeps
  // normal JSON parsing; express.json() skips this path because the raw
  // parser has already consumed the body.
  app.use(
    "/api/payments/webhook",
    express.raw({ type: "application/json", limit: "100kb" })
  );

  // Keep the general budget for non-auth traffic.
  app.use("/api", apiLimiter);

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

  // Demo/test endpoints exist in development and test ONLY. `isProduction`
  // is true only for an explicit NODE_ENV=production (env.ts never defaults
  // to production), so these routes can never be mounted in production.
  if (!env.isProduction && (env.NODE_ENV === "development" || env.NODE_ENV === "test")) {
    app.use("/api/test", testRoutes);
  }
  app.use("/api/services", serviceRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/reviews", reviewRoutes);
  app.use("/api/home", homeRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api", availabilityRoutes);
  app.use("/api/coupons", couponRoutes);
  app.use("/api/technician-applications", technicianApplicationRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/uploads", uploadRoutes);
  app.use("/api/payments", paymentRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
