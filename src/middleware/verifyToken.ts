
import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { getUsersCollection } from "../models/technician-application.model.js";
import { env } from "../config/env.js";

// Better Auth's JWT plugin signs tokens with its managed keys and exposes
// the public keys at {baseURL}/api/auth/jwks. We verify signatures against
// that remote JWKS instead of trusting any secret shared with the client.
// Issuer and audience are NOT guessed: the plugin defaults both to the
// configured baseURL (see JwtOptions in better-auth), which env.BETTER_AUTH_URL
// mirrors exactly after trailing-slash normalization.
const JWKS = createRemoteJWKSet(
  new URL(`${env.BETTER_AUTH_URL}/api/auth/jwks`),
  {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5000,
  }
);

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

const extractBearerToken = (
  authorization: string | undefined
): string | null => {
  if (!authorization) {
    return null;
  }

  const [scheme, ...rest] = authorization.trim().split(/\s+/);

  if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) {
    return null;
  }

  const token = rest[0];

  // A compact JWT has exactly three non-empty segments.
  if (!token || token.split(".").length !== 3) {
    return null;
  }

  return token;
};

export const verifyToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = extractBearerToken(req.headers.authorization);

    if (!token) {
      res.status(401).json({
        success: false,
        message: "Authentication token is required.",
      });
      return;
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.BETTER_AUTH_URL,
      audience: env.BETTER_AUTH_URL,
    });

    // The JWT carries the role only at issuance time, so the claim can lag
    // reality after a promotion/demotion or an application approval. The
    // database is always the authority for the current role; the JWT only
    // proves identity.
    if (
      typeof payload.id !== "string" ||
      payload.id.length === 0 ||
      typeof payload.email !== "string" ||
      payload.email.length === 0 ||
      typeof payload.role !== "string" ||
      payload.role.length === 0
    ) {
      res.status(401).json({
        success: false,
        message: "Invalid token payload.",
      });
      return;
    }

    const userId = new ObjectId(payload.id);

    let currentRole = "customer";

    // Fail closed, never permissive: a missing or unreadable role document
    // rejects the request. The JWT signature still verified; the database is
    // the second gate for anything that depends on the current role.
    try {
      const dbUser = await getUsersCollection().findOne(
        { _id: userId },
        { projection: { role: 1 } }
      );

      if (!dbUser) {
        res.status(401).json({
          success: false,
          message: "Account not found.",
        });
        return;
      }

      currentRole =
        typeof dbUser.role === "string" && dbUser.role.length > 0 ? dbUser.role : "customer";
    } catch {
      res.status(503).json({
        success: false,
        message: "Authentication could not be verified right now.",
      });
      return;
    }

    // Role comes exclusively from the fresh database lookup above — never
    // from the JWT claim alone and never from body/query/headers.
    req.user = {
      id: payload.id,
      email: payload.email,
      role: currentRole,
    };

    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
};
