
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { jwt } from "better-auth/plugins";
import { getDB } from "./db.js";
import { env } from "./env.js";

// Better Auth owns rate limiting for /api/auth. The configuration is
// explicit and environment-aware instead of relying on Better Auth's
// implicit defaults (production-only, 3 requests per 10s on credential
// paths, one shared bucket for all users when the client IP cannot be
// resolved). Production stays tight enough to blunt brute-force and
// credential stuffing; development/test stay generous because every local
// process shares 127.0.0.1.
const isProd = env.isProduction;

const credentialRule = { window: 60, max: isProd ? 10 : 100 };
const recoveryRule = { window: 300, max: isProd ? 5 : 100 };

// Better Auth must be created AFTER the MongoDB connection is established,
// because the MongoDB adapter reads from the live Db instance at request time.
// server.ts enforces this order: connectDB() -> createAuth() -> createApp().
export const createAuth = () => {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    // The frontend origin is trusted for credentialed CORS and for
    // Better Auth's origin/CSRF checks on state-changing requests.
    trustedOrigins: [env.CLIENT_URL],

    database: mongodbAdapter(getDB()),

    // Explicit rate limiting (enabled in every environment). Better Auth's
    // built-in defaults would otherwise apply only in production: 3 attempts
    // per 10s on credential paths — far too aggressive for legitimate users
    // — and, when the client IP cannot be resolved, a single shared bucket
    // for ALL users. Custom rules below override those defaults; they must
    // stay tighter than the general budget and loose enough for humans.
    rateLimit: {
      enabled: true,
      // Default for endpoints without a specific rule (seconds).
      window: 60,
      max: isProd ? 100 : 1000,
      // Per-process memory store: correct for a single instance. If you
      // scale to multiple replicas, switch to "database" or a shared
      // secondary storage — otherwise each replica gets its own budget.
      storage: "memory",
      customRules: {
        "/sign-in/*": credentialRule,
        "/sign-up/*": credentialRule,
        "/change-password": { window: 60, max: isProd ? 5 : 100 },
        "/change-email": { window: 60, max: isProd ? 5 : 100 },
        // Email-recovery endpoints: rare in legitimate use, prime abuse target.
        "/request-password-reset": recoveryRule,
        "/forget-password/*": recoveryRule,
        "/send-verification-email": recoveryRule,
      },
    },

    advanced: {
    ipAddress: {
      // Better Auth reads X-Forwarded-For directly (Express's `trust proxy`
      // setting does not apply to it). Only honor a multi-hop proxy chain
      // when the operator has declared the proxies via TRUSTED_PROXIES;
      // otherwise a spoofed or unresolvable header falls back to one
      // shared bucket and locks out every user at once.
      ...(env.TRUSTED_PROXIES.length > 0
        ? { trustedProxies: [...env.TRUSTED_PROXIES] }
        : {}),
    },
    // The deployed frontend (Vercel) and backend (Render) are different sites,
    // so session cookies must be sent on cross-site requests. SameSite=None is
    // required for that; browsers also require Secure with None. Better Auth's
    // default is SameSite=Lax, which prevents the browser from attaching the
    // cookie to cross-origin API calls even with CORS credentials enabled.
    // Production is HTTPS-only (enforced in env validation), so Secure cookies
    // are safe here. Local development keeps the Lax default.
    ...(env.isProduction
      ? {
          defaultCookieAttributes: {
            sameSite: "none",
            secure: true,
          },
        }
      : {}),
  },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },

    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "customer",
          // Never accepted from public signup/update input. Role changes
          // must go through a trusted server-side path (e.g. admin tooling).
          input: false,
        },
        phone: {
          type: "string",
          required: false,
        },
        area: {
          type: "string",
          required: false,
        },
        bio: {
          type: "string",
          required: false,
        },
      },
    },

    plugins: [
      jwt({
        jwt: {
          definePayload: ({ user }) => ({
            id: user.id,
            email: user.email,
            role: user.role,
          }),
        },
      }),
    ],
  });
};

export type Auth = ReturnType<typeof createAuth>;
