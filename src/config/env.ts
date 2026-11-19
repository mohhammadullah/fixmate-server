
import "dotenv/config";
import { z } from "zod";

// Isolated production-mode test harnesses bind to a loopback port over plain
// HTTP. Those URLs are not public, so they are exempt from the HTTPS rule;
// every externally reachable production URL must be HTTPS.
const isLoopbackHttp = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
};

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  CLIENT_URL: z.string().url().default("http://localhost:3000"),
  MONGODB_URI: z
    .string()
    .min(1, "MONGODB_URI is required")
    .refine(
      (value) =>
        value.startsWith("mongodb://") || value.startsWith("mongodb+srv://"),
      "MONGODB_URI must start with mongodb:// or mongodb+srv://"
    ),
  MONGODB_DB_NAME: z.string().min(1, "MONGODB_DB_NAME is required"),
  // Comma-separated reverse-proxy IPs or CIDR ranges (e.g.
  // "10.0.0.0/8,192.168.1.10"). Passed to Better Auth so it can resolve the
  // real client IP from X-Forwarded-For and key rate limits per client
  // instead of falling back to one shared bucket. Leave unset only when
  // clients connect directly. Never set this to a range you do not control.
  TRUSTED_PROXIES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
    .pipe(
      z.array(
        z
          .string()
          .regex(
            /^[0-9a-fA-F.:]+(\/\d{1,3})?$/,
            "TRUSTED_PROXIES entries must be IPs or CIDR ranges"
          )
      )
    ),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters long"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
  // Optional so the server and test suite can start without Stripe
  // credentials. Endpoints that need Stripe return a safe 503 when it is
  // not configured; the rest of the API keeps working.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Lowercase ISO 4217 currency used for new Checkout Sessions.
  // Safe default: usd. Set to bdt only when your Stripe account and
  // payment method support BDT.
  STRIPE_CURRENCY: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/, "STRIPE_CURRENCY must be a lowercase 3-letter ISO 4217 code")
    .default("usd"),
  // Overridable for a local mock of the Stripe API in tests. Never set in
  // production.
  STRIPE_API_BASE: z.string().url().optional(),
  // Optional ImgBB so the server and test suite can start without an ImgBB account.
  // The upload endpoint refuses requests with a safe 503 when it is missing.
  IMGBB_API_KEY: z.string().min(1).optional(),
  // Overridable for local/mock ImgBB responses in tests. Not a secret.
  IMGBB_UPLOAD_URL: z
    .string()
    .url()
    .default("https://api.imgbb.com/1/upload"),
  // Optional platform tax rate applied to invoices, e.g. "0.05" for 5%.
  // Leave unset/0 when no platform tax is configured. Applied on the
  // discounted service amount; snapshotted into the immutable invoice.
  INVOICE_TAX_RATE: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, "INVOICE_TAX_RATE must be a non-negative decimal")
    .optional()
    .transform((v) => (v === undefined ? 0 : Number(v)))
    .refine((v) => Number.isFinite(v) && v >= 0 && v <= 0.9, "INVOICE_TAX_RATE must be between 0 and 0.9"),
}).superRefine((value, ctx) => {
  // Stripe credentials are a pair: a key without a webhook secret would let
  // customers start a Checkout Session that can never be settled. Applies to
  // every environment so development cannot silently acquire the same bug.
  const hasStripeKey = Boolean(value.STRIPE_SECRET_KEY);
  const hasWebhookSecret = Boolean(value.STRIPE_WEBHOOK_SECRET);
  if (hasStripeKey !== hasWebhookSecret) {
    ctx.addIssue({
      code: "custom",
      path: [hasStripeKey ? "STRIPE_WEBHOOK_SECRET" : "STRIPE_SECRET_KEY"],
      message:
        "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must both be configured or both be absent",
    });
  }

  // Production is enabled ONLY by an explicit NODE_ENV=production. An unset
  // NODE_ENV stays "development"; production-only checks below therefore
  // cannot fire by accident in local/test environments.
  if (value.NODE_ENV !== "production") return;

  if (!process.env.CLIENT_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["CLIENT_URL"],
      message: "CLIENT_URL must be set explicitly in production (no localhost default)",
    });
  }

  for (const key of ["CLIENT_URL", "BETTER_AUTH_URL"] as const) {
    try {
      const candidate = value[key];
      if (new URL(candidate).protocol !== "https:" && !isLoopbackHttp(candidate)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must use HTTPS in production`,
        });
      }
    } catch {
      // z.string().url() has already reported a malformed value.
    }
  }

  if (process.env.STRIPE_API_BASE) {
    ctx.addIssue({
      code: "custom",
      path: ["STRIPE_API_BASE"],
      message: "STRIPE_API_BASE is a test-only override and must not be set in production",
    });
  }
  if (process.env.IMGBB_UPLOAD_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["IMGBB_UPLOAD_URL"],
      message: "IMGBB_UPLOAD_URL is a test-only override and must not be set in production",
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".") || "env"}: ${issue.message}`);
  }
  process.exit(1);
}

// Normalize BETTER_AUTH_URL so the JWT issuer/audience and JWKS URL are
// consistent regardless of a trailing slash in the environment value.
const betterAuthUrl = parsed.data.BETTER_AUTH_URL.replace(/\/+$/, "");
const clientUrl = parsed.data.CLIENT_URL.replace(/\/+$/, "");

export const env = {
  ...parsed.data,
  CLIENT_URL: clientUrl,
  BETTER_AUTH_URL: betterAuthUrl,
  TRUSTED_PROXIES: parsed.data.TRUSTED_PROXIES ?? [],
  // True only when BOTH Stripe credentials are present. Validation above
  // guarantees they are a pair; payment endpoints use this single flag.
  paymentsConfigured: Boolean(
    parsed.data.STRIPE_SECRET_KEY && parsed.data.STRIPE_WEBHOOK_SECRET
  ),
  isProduction: parsed.data.NODE_ENV === "production",
  isDevelopment: parsed.data.NODE_ENV === "development",
} as const;
