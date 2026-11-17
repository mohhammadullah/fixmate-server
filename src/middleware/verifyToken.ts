
import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
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

    // Role comes exclusively from the verified token. Any role supplied
    // in the request body, query or headers is deliberately ignored.
    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
    };

    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
};
