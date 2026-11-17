
import type { Request, Response } from "express";
import { ObjectId, type Filter, type Sort } from "mongodb";
import type Stripe from "stripe";
import { env } from "../config/env.js";
import {
  getStripeClient,
  isStripeConfigured,
  stripeCurrency,
} from "../config/stripe.js";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import {
  checkoutSessionSchema,
  listMyPaymentsQuerySchema,
} from "../validators/payment.validator.js";
import { getBookingsCollection } from "../models/booking.model.js";
import {
  getPaymentsCollection,
  type Payment,
  type PaymentStatus,
} from "../models/payment.model.js";
import { toMinorUnits, fromMinorUnits } from "../utils/currency.js";

// MongoDB duplicate-key error (unique index violation), matched by code so
// it works regardless of which unique index was violated and without
// `instanceof` across driver builds.
const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

// Identity comes exclusively from the verified JWT; a missing JWT payload
// is rejected here as defense-in-depth (the route middleware already
// enforces it). Same convention as the booking controller.
const resolveAuthUserId = (
  req: AuthenticatedRequest
): ObjectId | null => {
  if (!req.user || !ObjectId.isValid(req.user.id)) {
    return null;
  }
  return new ObjectId(req.user.id);
};

const PAYMENT_SORT: Sort = { createdAt: -1, _id: -1 };

// Safe DTO for payment responses. Internal MongoDB fields (_id,
// technicianId, bookingId policy aside) and the Stripe internals
// (checkoutUrl after completion, session ids, payment intents) are
// excluded. `amount` is returned in major currency units.
interface PaymentDTO {
  id: string;
  bookingId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
  paidAt?: Date;
}

const toPaymentDTO = (payment: Payment): PaymentDTO => {
  const dto: PaymentDTO = {
    id: payment._id.toHexString(),
    bookingId: payment.bookingId.toHexString(),
    amount: fromMinorUnits(payment.amount, payment.currency),
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };

  if (payment.paidAt) {
    dto.paidAt = payment.paidAt;
  }

  return dto;
};

interface CheckoutSessionDTO {
  url: string;
  expiresAt?: Date;
  amount: number;
  currency: string;
  bookingId: string;
}

const toCheckoutSessionDTO = (payment: Payment): CheckoutSessionDTO => {
  if (!payment.checkoutUrl) {
    throw new Error("checkout session DTO requires a checkout URL");
  }

  const dto: CheckoutSessionDTO = {
    url: payment.checkoutUrl,
    amount: fromMinorUnits(payment.amount, payment.currency),
    currency: payment.currency,
    bookingId: payment.bookingId.toHexString(),
  };

  if (payment.expiresAt) {
    dto.expiresAt = payment.expiresAt;
  }

  return dto;
};

// After a duplicate-key insert race, the winning request may not have
// written `checkoutUrl` yet. Poll briefly for it instead of failing the
// loser's request — both callers end up with the same hosted URL.
const waitForCheckoutUrl = async (
  bookingId: ObjectId
): Promise<Payment | null> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const existing = await getPaymentsCollection().findOne({
      bookingId,
      status: "pending",
    });

    if (existing?.checkoutUrl) {
      return existing;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return null;
};

const PAYMENT_UNAVAILABLE_MESSAGE =
  "Online payments are not configured right now. Please try again later.";

// POST /api/payments/checkout-session — customer only (verifyToken ->
// verifyCustomer). Creates a Stripe Checkout Session for the customer's
// own completed, unpaid booking. Amount and currency come from the
// server-side booking snapshot (finalAmount), never from the client;
// customer identity comes exclusively from the verified JWT.
//
// Idempotency: at most one pending Checkout Session may exist per booking
// (partial unique index `payments_one_pending_per_booking_unique`). A
// placeholder record is inserted BEFORE the Stripe API is called, so the
// unique index acts as the race claim — the loser never reaches Stripe and
// re-reads the winner's record instead, returning the same hosted URL.
export const createCheckoutSession = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  const customerId = resolveAuthUserId(req);

  if (!customerId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const parsed = checkoutSessionSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const bookingId = new ObjectId(parsed.data.bookingId);

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const booking = await getBookingsCollection().findOne({
    _id: bookingId,
    customerId,
  });

  if (!booking) {
    res.status(404).json({
      success: false,
      message: "Booking not found.",
    });
    return;
  }

  if (booking.status !== "completed") {
    res.status(409).json({
      success: false,
      message: "Only completed bookings can be paid.",
    });
    return;
  }

  if (booking.paymentStatus !== "unpaid") {
    res.status(409).json({
      success: false,
      message: "This booking has already been paid.",
    });
    return;
  }

  const finalAmount = booking.finalAmount;

  if (
    typeof finalAmount !== "number" ||
    !Number.isFinite(finalAmount) ||
    finalAmount <= 0
  ) {
    res.status(409).json({
      success: false,
      message: "The final amount for this booking is not available yet.",
    });
    return;
  }

  const stripe = getStripeClient();

  if (!isStripeConfigured || !stripe) {
    res.status(503).json({
      success: false,
      message: PAYMENT_UNAVAILABLE_MESSAGE,
    });
    return;
  }

  const currency = stripeCurrency;
  const amount = toMinorUnits(finalAmount, currency);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    res.status(500).json({
      success: false,
      message: "Unable to price this booking. Please contact support.",
    });
    return;
  }

  // Idempotent reuse: an existing pending checkout for this booking is
  // returned as-is, so a customer double-clicking (or retrying after a
  // redirect slip) lands on the same hosted session.
  const existing = await getPaymentsCollection().findOne({
    bookingId,
    status: "pending",
  });

  if (existing?.checkoutUrl) {
    if (!existing.expiresAt || existing.expiresAt.getTime() > Date.now()) {
      res.status(200).json({
        success: true,
        data: toCheckoutSessionDTO(existing),
      });
      return;
    }

    // The session expired provider-side without a webhook (e.g. it never
    // reached the customer). Retire it so a fresh session can be created.
    await getPaymentsCollection().updateOne(
      { _id: existing._id, status: "pending" },
      { $set: { status: "expired", updatedAt: new Date() } }
    );
  } else if (existing) {
    // Another request is between the Stripe call and the database update
    // right now.
    const ready = await waitForCheckoutUrl(bookingId);

    if (ready) {
      res.status(200).json({
        success: true,
        data: toCheckoutSessionDTO(ready),
      });
      return;
    }

    res.status(409).json({
      success: false,
      message:
        "A payment for this booking is already in progress. Please try again in a moment.",
    });
    return;
  }

  // Claim the pending slot first. The partial unique index
  // `payments_one_pending_per_booking_unique` is the authoritative race
  // guard: at most one pending payment may exist per booking. The winner
  // proceeds to Stripe; the loser reuses the winner's record. Stripe is
  // never called for a request that lost the claim, so a booking can
  // never open two sessions.
  const now = new Date();
  const paymentId = new ObjectId();
  const placeholder: Payment = {
    _id: paymentId,
    bookingId,
    customerId,
    technicianId: booking.technicianId,
    amount,
    currency,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  try {
    await getPaymentsCollection().insertOne(placeholder);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const ready = await waitForCheckoutUrl(bookingId);

      if (ready) {
        res.status(200).json({
          success: true,
          data: toCheckoutSessionDTO(ready),
        });
        return;
      }

      res.status(409).json({
        success: false,
        message:
          "A payment for this booking is already in progress. Please try again in a moment.",
      });
      return;
    }

    throw error;
  }

  let session: Stripe.Checkout.Session;

  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amount,
            product_data: {
              name: `FixMate repair — ${booking.serviceTitle}`,
            },
          },
        },
      ],
      // The customer's email comes from the server-side booking snapshot,
      // never from the request.
      customer_email: booking.customerEmail,
      client_reference_id: bookingId.toHexString(),
      metadata: {
        bookingId: bookingId.toHexString(),
        customerId: customerId.toHexString(),
      },
      success_url: `${env.CLIENT_URL}/dashboard/payments/success?booking_id=${bookingId.toHexString()}`,
      cancel_url: `${env.CLIENT_URL}/dashboard/payments/cancel?booking_id=${bookingId.toHexString()}`,
    });
  } catch (error) {
    // Stripe refused the session. Roll back the pending claim so the
    // customer can retry instead of being stuck on a placeholder.
    await getPaymentsCollection()
      .deleteOne({ _id: paymentId, status: "pending" })
      .catch(() => undefined);

    // Log only the message — never keys, never full provider responses.
    console.error(
      "Stripe checkout session creation failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    res.status(502).json({
      success: false,
      message:
        "Couldn't create a secure checkout session right now. Please try again.",
    });
    return;
  }

  if (!session.id || !session.url) {
    await getPaymentsCollection()
      .deleteOne({ _id: paymentId, status: "pending" })
      .catch(() => undefined);

    console.error("Stripe returned a checkout session without id or url.");
    res.status(502).json({
      success: false,
      message:
        "Couldn't create a secure checkout session right now. Please try again.",
    });
    return;
  }

  const expiresAt =
    typeof session.expires_at === "number" && Number.isFinite(session.expires_at)
      ? new Date(session.expires_at * 1000)
      : undefined;

  const update: Partial<Pick<Payment, "stripeSessionId" | "checkoutUrl" | "expiresAt" | "stripePaymentIntentId" | "updatedAt">> = {
    stripeSessionId: session.id,
    checkoutUrl: session.url,
    updatedAt: new Date(),
  };

  if (expiresAt) {
    update.expiresAt = expiresAt;
  }

  const recorded = await getPaymentsCollection().findOneAndUpdate(
    { _id: paymentId, status: "pending" },
    { $set: update },
    { returnDocument: "after" }
  );

  if (!recorded) {
    // The claim vanished between insert and update (e.g. rolled back
    // externally). Never hand out a session we cannot track.
    console.error(
      `[payments] pending claim ${paymentId.toHexString()} vanished before it could be recorded`
    );
    res.status(502).json({
      success: false,
      message:
        "Couldn't create a secure checkout session right now. Please try again.",
    });
    return;
  }

  res.status(201).json({
    success: true,
    data: toCheckoutSessionDTO(recorded),
  });
};

// GET /api/payments/my — customer only (verifyToken -> verifyCustomer).
// Returns only the authenticated customer's own payments, newest first,
// with the same pagination metadata convention as the booking lists.
export const listMyPayments = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  const customerId = resolveAuthUserId(req);

  if (!customerId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const parsed = listMyPaymentsQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const page = parsed.data.page ?? 1;
  // Chosen behavior (consistent with the other list endpoints): limit
  // above 50 is rejected with HTTP 400.
  const limit = parsed.data.limit ?? 10;

  const filter: Filter<Payment> = { customerId };

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const [items, totalItems] = await Promise.all([
    getPaymentsCollection()
      .find(filter)
      .sort(PAYMENT_SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getPaymentsCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

  res.status(200).json({
    success: true,
    data: items.map(toPaymentDTO),
    pagination: {
      currentPage: page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  });
};

// ---------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------

const toHexOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

// Marks a pending payment as expired/failed. Bookings are never touched
// for these events — the customer simply has no way to pay against them.
const settlePendingPayment = async (
  session: Stripe.Checkout.Session,
  status: "expired" | "failed"
): Promise<void> => {
  const sessionId = toHexOrNull(session?.id);

  if (!sessionId) {
    return;
  }

  await getPaymentsCollection().updateOne(
    { stripeSessionId: sessionId, status: "pending" },
    { $set: { status, updatedAt: new Date() } }
  );
};

// Reconciles a completed Checkout Session against the stored payment
// record before anything is marked paid:
//   1. the session id must be one we recorded;
//   2. the session metadata booking reference, amount and currency must
//      match our record exactly;
//   3. the booking must still belong to the recorded customer and its
//      settled final amount must price to the recorded minor-unit amount;
//   4. the payment record must still be pending (double delivery is a
//      no-op; the booking is reconciled as a self-heal).
// Mismatches mark the payment failed and leave the booking untouched.
const settleCompletedSession = async (
  session: Stripe.Checkout.Session
): Promise<void> => {
  const sessionId = toHexOrNull(session?.id);

  if (!sessionId) {
    return;
  }

  const payment = await getPaymentsCollection().findOne({
    stripeSessionId: sessionId,
  });

  if (!payment) {
    // Unknown session — acknowledged and ignored so Stripe stops retrying.
    console.error(`[payments] webhook for unrecorded session ${sessionId}`);
    return;
  }

  const metadata = session.metadata ?? undefined;
  const sessionBookingId = toHexOrNull(metadata?.bookingId);
  const sessionAmount =
    typeof session.amount_total === "number" ? session.amount_total : null;
  const sessionCurrency =
    typeof session.currency === "string" ? session.currency.toLowerCase() : null;

  const mismatches: string[] = [];

  if (sessionBookingId !== payment.bookingId.toHexString()) {
    mismatches.push("booking");
  }

  if (sessionAmount !== payment.amount) {
    mismatches.push("amount");
  }

  if (sessionCurrency !== payment.currency) {
    mismatches.push("currency");
  }

  if (mismatches.length > 0) {
    await getPaymentsCollection().updateOne(
      { _id: payment._id, status: "pending" },
      { $set: { status: "failed", updatedAt: new Date() } }
    );
    console.error(
      `[payments] session mismatch (${mismatches.join(",")}) for payment ${payment._id.toHexString()}; booking left unchanged`
    );
    return;
  }

  const booking = await getBookingsCollection().findOne({
    _id: payment.bookingId,
  });

  const expectedMinor =
    booking && typeof booking.finalAmount === "number" && Number.isFinite(booking.finalAmount)
      ? toMinorUnits(booking.finalAmount, payment.currency)
      : null;

  if (
    !booking ||
    booking.customerId.toHexString() !== payment.customerId.toHexString() ||
    expectedMinor !== payment.amount
  ) {
    await getPaymentsCollection().updateOne(
      { _id: payment._id, status: "pending" },
      { $set: { status: "failed", updatedAt: new Date() } }
    );
    console.error(
      `[payments] booking reconciliation failed for payment ${payment._id.toHexString()}; booking left unchanged`
    );
    return;
  }

  const paidAt = new Date();
  const paymentIntentId = toHexOrNull(session.payment_intent);

  const claimed = await getPaymentsCollection().findOneAndUpdate(
    { _id: payment._id, status: "pending" },
    {
      $set: {
        status: "succeeded",
        paidAt,
        updatedAt: paidAt,
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      },
    },
    { returnDocument: "after" }
  );

  if (!claimed) {
    // Already settled (Stripe redelivered the event). Reconcile the
    // booking defensively in case a previous attempt died between the
    // payment update and the booking update.
    await getBookingsCollection().updateOne(
      { _id: payment.bookingId, paymentStatus: "unpaid" },
      { $set: { paymentStatus: "paid", updatedAt: paidAt } }
    );
    return;
  }

  await getBookingsCollection().updateOne(
    { _id: payment.bookingId, paymentStatus: "unpaid" },
    { $set: { paymentStatus: "paid", updatedAt: paidAt } }
  );
};

// POST /api/payments/webhook — no auth middleware; the Stripe signature is
// verified against the raw request body with STRIPE_WEBHOOK_SECRET. Always
// answers 200 for handled (and uninteresting) events; 400 only for a
// missing signature or raw-body misconfiguration, and 503 when the webhook
// secret is not configured. Processing failures answer 500 so Stripe
// retries — the handler is idempotent.
export const handleStripeWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  const stripe = getStripeClient();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    res.status(503).json({
      success: false,
      message: "Payments webhook is not configured.",
    });
    return;
  }

  const signature = req.headers["stripe-signature"];

  if (typeof signature !== "string" || signature.length === 0) {
    res.status(400).json({
      success: false,
      message: "Missing Stripe signature.",
    });
    return;
  }

  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({
      success: false,
      message: "Webhook requires the raw request body.",
    });
    return;
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    res.status(400).json({
      success: false,
      message: "Invalid webhook signature.",
    });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await settleCompletedSession(
          event.data.object as Stripe.Checkout.Session
        );
        break;
      case "checkout.session.expired":
        await settlePendingPayment(
          event.data.object as Stripe.Checkout.Session,
          "expired"
        );
        break;
      case "checkout.session.async_payment_failed":
        await settlePendingPayment(
          event.data.object as Stripe.Checkout.Session,
          "failed"
        );
        break;
      default:
        // Uninteresting event types are acknowledged and ignored.
        break;
    }
  } catch (error) {
    console.error(
      "Stripe webhook processing failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    // Answering 500 tells Stripe to retry; the handler is idempotent.
    res.status(500).json({
      success: false,
      message: "Webhook processing failed.",
    });
    return;
  }

  res.status(200).json({ received: true });
};
