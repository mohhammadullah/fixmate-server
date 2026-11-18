
import { z } from "zod";

// Customer review submission. A review is stored as a subdocument on the
// booking; the rating and comment are the only client-editable fields.
// Ownership, eligibility (completed status), and one-review-per-booking are
// enforced server-side in the controller + the atomic update filter — never
// from these fields. z.strictObject rejects any extra keys (customerId,
// serviceId, technicianId, timestamps, …).
export const createReviewSchema = z.strictObject({
  rating: z
    .number({
      error: "Rating is required and must be a number",
    })
    .int("Rating must be a whole number between 1 and 5")
    .min(1, "Rating must be at least 1")
    .max(5, "Rating must be at most 5"),
  comment: z
    .string({
      error: "Comment is required and must be a string",
    })
    .trim()
    .min(10, "Comment must be at least 10 characters long")
    .max(1000, "Comment must be at most 1000 characters long"),
});

export type CreateReviewInput = z.input<typeof createReviewSchema>;
export type CreateReviewData = z.infer<typeof createReviewSchema>;

// Public "latest reviews" listing query. Unknown query keys are stripped.
// `limit` defaults to 6 (homepage); the dedicated /reviews page uses
// `page` + `limit` for true pagination. Capped so both use cases stay bounded.
const positiveIntQuerySchema = (label: string, max?: number) => {
  const base = z
    .string({ error: `${label} must be a string` })
    .trim()
    .refine(
      (value) => /^[1-9]\d*$/.test(value),
      `${label} must be a positive integer`
    )
    .transform(Number)
    .pipe(z.number().int().min(1, `${label} must be at least 1`));

  return (
    max === undefined
      ? base
      : base.pipe(z.number().int().max(max, `${label} must be at most ${max}`))
  ).optional();
};

// Homepage testimonials: the newest 6 by default. The /reviews page passes
// page & limit (up to 24 per page) to walk the full set.
export const latestReviewsQuerySchema = z.object({
  page: positiveIntQuerySchema("page"),
  limit: positiveIntQuerySchema("limit", 24),
});

export type LatestReviewsQueryData = z.infer<typeof latestReviewsQuerySchema>;
