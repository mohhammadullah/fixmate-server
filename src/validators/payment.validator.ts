
import { z } from "zod";

// Strict 24-character hexadecimal ObjectId (ObjectId.isValid would also
// accept 12-byte strings, so check explicitly). Mirrors the booking
// validator's convention.
export const OBJECT_ID_HEX_REGEX = /^[0-9a-fA-F]{24}$/;

// Shared positive-integer query schema (same convention as the booking and
// service list validators). Unknown query keys are stripped — never trusted.
// Empty strings are rejected. A limit above 50 is rejected with HTTP 400
// rather than silently capped.
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

// Checkout session creation accepts the booking reference ONLY. Amount,
// currency, customer identity, payment status and any other field are
// server-controlled and deliberately absent: z.strictObject rejects any
// key outside this shape.
export const checkoutSessionSchema = z.strictObject({
  bookingId: z
    .string({ error: "bookingId is required and must be a string" })
    .trim()
    .regex(
      OBJECT_ID_HEX_REGEX,
      "bookingId must be a 24-character hexadecimal ObjectId"
    ),
});

export type CheckoutSessionInput = z.input<typeof checkoutSessionSchema>;
export type CheckoutSessionData = z.infer<typeof checkoutSessionSchema>;

// Customer payment-history query. Chosen behavior (consistent with the
// other list endpoints): limit defaults to 10 and a limit above 50 is
// rejected with HTTP 400.
export const listMyPaymentsQuerySchema = z.object({
  page: positiveIntQuerySchema("page"),
  limit: positiveIntQuerySchema("limit", 50),
});

export type ListMyPaymentsQueryInput = z.input<typeof listMyPaymentsQuerySchema>;
export type ListMyPaymentsQueryData = z.infer<typeof listMyPaymentsQuerySchema>;
