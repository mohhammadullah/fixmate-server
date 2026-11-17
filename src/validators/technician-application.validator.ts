import { z } from "zod";
import { APPLICATION_STATUSES } from "../models/technician-application.model.js";

// Strict client-editable application fields. Role, status, reviewedBy,
// reviewedAt and timestamps are server-controlled and rejected by the
// strict object shape.
export const submitApplicationSchema = z.strictObject({
  phone: z
    .string({ error: "Phone is required and must be a string" })
    .trim()
    .regex(/^[0-9+\-()\s]{5,30}$/, "Phone must be 5–30 characters using digits, +, -, ( ) or spaces"),
  area: z
    .string({ error: "Area is required and must be a string" })
    .trim()
    .min(2, "Area must be at least 2 characters long")
    .max(120, "Area must be at most 120 characters long"),
  experience: z
    .number({ error: "Experience must be a number" })
    .int("Experience must be a whole number of years")
    .min(0, "Experience cannot be negative")
    .max(60, "Experience must be at most 60 years"),
  skills: z
    .array(
      z
        .string({ error: "Each skill must be a string" })
        .trim()
        .min(1, "Skills cannot contain empty strings")
        .max(60, "Each skill must be at most 60 characters long"),
      { error: "Skills must be an array of strings" }
    )
    .min(1, "Provide at least one skill")
    .max(20, "Skills can contain at most 20 entries"),
  bio: z
    .string({ error: "Bio is required and must be a string" })
    .trim()
    .min(20, "Bio must be at least 20 characters long")
    .max(1000, "Bio must be at most 1000 characters long"),
});

export const applicationQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUSES, {
    error: `Status must be one of: ${APPLICATION_STATUSES.join(", ")}`,
  }).optional(),
  page: z.coerce.number().int().min(1, "page must be at least 1").optional(),
  limit: z.coerce.number().int().min(1, "limit must be at least 1").max(50, "limit must be at most 50").optional(),
});

export const reviewApplicationSchema = z.strictObject({
  decision: z.enum(["approve", "reject"], {
    error: "Decision must be either approve or reject",
  }),
  rejectionReason: z
    .string({ error: "Rejection reason must be a string" })
    .trim()
    .min(1, "Rejection reason is required when rejecting")
    .max(500, "Rejection reason must be at most 500 characters long")
    .optional(),
}).refine(
  (data) => data.decision !== "reject" || Boolean(data.rejectionReason),
  { message: "A rejection reason is required when rejecting", path: ["rejectionReason"] }
);

export type SubmitApplicationInput = z.input<typeof submitApplicationSchema>;
export type ReviewApplicationInput = z.infer<typeof reviewApplicationSchema>;
