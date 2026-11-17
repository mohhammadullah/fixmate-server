
import "dotenv/config";
import { z } from "zod";

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
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters long"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
  // Optional so the server and test suite can start without an ImgBB account.
  // The upload endpoint refuses requests with a safe 503 when it is missing.
  IMGBB_API_KEY: z.string().min(1).optional(),
  // Overridable for local/mock ImgBB responses in tests. Not a secret.
  IMGBB_UPLOAD_URL: z
    .string()
    .url()
    .default("https://api.imgbb.com/1/upload"),
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
  isProduction: parsed.data.NODE_ENV === "production",
  isDevelopment: parsed.data.NODE_ENV === "development",
} as const;
