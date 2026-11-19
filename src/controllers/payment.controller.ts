
import type { Request, Response } from "express";
import { ObjectId, type Filter, type Sort } from "mongodb";
import { isObjectIdHex } from "../utils/objectid.js";
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
  listTechnicianPaymentsQuerySchema,
} from "../validators/payment.validator.js";
import { getBookingsCollection, type Booking } from "../models/booking.model.js";
import {
  canonicalizeCategory,
  type ServiceCategory,
} from "../models/service.model.js";
import {
  getPaymentsCollection,
  PAYMENTS_COLLECTION,
  type Payment,
  type PaymentRefund,
  type PaymentStatus,
  type RefundStatus,
} from "../models/payment.model.js";
import { toMinorUnits, fromMinorUnits } from "../utils/currency.js";
import { ensureInvoiceForBooking, setInvoicePaymentStatus } from "../utils/invoice.js";
import { emitBookingEvent } from "../utils/booking-events.js";
import {
  claimCouponRedemption,
  releaseCouponUsageSlot,
} from "./coupon.controller.js";

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
  if (!req.user || !isObjectIdHex(req.user.id)) {
    return null;
  }
  return new ObjectId(req.user.id);
};

const PAYMENT_SORT: Sort = { createdAt: -1, _id: -1 };

// Safe DTO for payment responses. Internal MongoDB fields (_id,
// technicianId, bookingId policy aside) and the Stripe internals
// (checkoutUrl after completion, session ids, payment intents) are
// excluded. `amount` is returned in major currency units.
// Customer-safe refund view. Stripe internals (idempotency key, Stripe
// refund id) and the deciding admin id are deliberately excluded.
interface CustomerRefundDTO {
  id: string;
  amountMinor: number;
  amount: number;
  currency: string;
  reason: string;
  status: RefundStatus;
  requestedAt: Date;
  decidedAt?: Date;
  decisionNote?: string;
  failureReason?: string;
}

const toCustomerRefundDTO = (refund: PaymentRefund): CustomerRefundDTO => ({
  id: refund.id,
  amountMinor: refund.amountMinor,
  amount: fromMinorUnits(refund.amountMinor, refund.currency),
  currency: refund.currency,
  reason: refund.reason,
  status: refund.status,
  requestedAt: refund.requestedAt,
  ...(refund.decidedAt ? { decidedAt: refund.decidedAt } : {}),
  ...(refund.decisionNote ? { decisionNote: refund.decisionNote } : {}),
  ...(refund.failureReason ? { failureReason: refund.failureReason } : {}),
});

interface PaymentDTO {
  id: string;
  bookingId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
  paidAt?: Date;
  /** Present only when refund records exist; the customer's own requests. */
  refunds?: CustomerRefundDTO[];
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
  if (payment.refunds?.length) {
    dto.refunds = payment.refunds.map(toCustomerRefundDTO);
  }

  return dto;
};

interface CheckoutSessionDTO {
  url: string;
  expiresAt?: Date;
  amount: number;
  currency: string;
  bookingId: string;
  appliedCoupon?: {
    code: string;
    discountAmount: number;
  };
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

  if (payment.appliedCoupon) {
    dto.appliedCoupon = {
      code: payment.appliedCoupon.code,
      discountAmount: payment.appliedCoupon.discountAmount,
    };
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

  const couponCode = parsed.data.couponCode;
  const currency = stripeCurrency;
  const fullAmount = toMinorUnits(finalAmount, currency);

  if (!Number.isSafeInteger(fullAmount) || fullAmount <= 0) {
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

  if (couponCode && existing?.checkoutUrl) {
    // A pending session already locks in its (possibly coupon-less) price;
    // Stripe cannot be updated to add a discount. Tell the customer to
    // finish or wait for expiry instead of charging a mismatched amount.
    res.status(409).json({
      success: false,
      message:
        "A checkout is already in progress for this booking. Complete it or wait for it to expire, then apply the coupon.",
    });
    return;
  }

  // Coupon: validate + atomically claim a redemption slot BEFORE any Stripe
  // work. The discount is computed entirely server-side from finalAmount.
  let appliedCoupon: Payment["appliedCoupon"] | undefined;
  let claimResult: Awaited<ReturnType<typeof claimCouponRedemption>> | undefined;
  if (couponCode && !existing) {
    claimResult = await claimCouponRedemption(
      couponCode,
      finalAmount,
      currency,
      customerId,
      canonicalizeCategory(booking.serviceCategory) ??
        (booking.serviceCategory as ServiceCategory)
    );
    if (!claimResult.ok) {
      res.status(400).json({ success: false, message: claimResult.message });
      return;
    }
    appliedCoupon = {
      code: claimResult.coupon.code,
      kind: claimResult.coupon.kind,
      value: claimResult.coupon.value,
      discountAmount: claimResult.discount,
      currency,
      appliedAt: new Date(),
    };
  }

  const amount = appliedCoupon
    ? toMinorUnits(Math.max(0.01, Math.round((finalAmount - appliedCoupon.discountAmount) * 100) / 100), currency)
    : fullAmount;

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    // Roll back the claimed slot before failing — the customer is never
    // charged and never charged a negative amount.
    if (claimResult?.ok) {
      await releaseCouponUsageSlot(couponCode!);
    }
    res.status(500).json({
      success: false,
      message: "Unable to price this booking. Please contact support.",
    });
    return;
  }

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
    ...(appliedCoupon ? { appliedCoupon } : {}),
    createdAt: now,
    updatedAt: now,
  };

  try {
    await getPaymentsCollection().insertOne(placeholder);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Reuse the winner's in-flight session — release our redundant slot.
      if (claimResult?.ok && couponCode) {
        await releaseCouponUsageSlot(couponCode).catch(() => undefined);
      }
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

    if (claimResult?.ok && couponCode) {
      await releaseCouponUsageSlot(couponCode).catch(() => undefined);
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

    if (claimResult?.ok && couponCode) {
      await releaseCouponUsageSlot(couponCode).catch(() => undefined);
    }

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

    if (claimResult?.ok && couponCode) {
      await releaseCouponUsageSlot(couponCode).catch(() => undefined);
    }

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
    if (claimResult?.ok && couponCode) {
      await releaseCouponUsageSlot(couponCode).catch(() => undefined);
    }
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

  // Best-effort mirror of the coupon snapshot onto the booking so the
  // invoice layer can read it later. Failures here never fail checkout —
  // the payment document carries the same data and the webhook derives
  // everything from there.
  if (appliedCoupon) {
    try {
      await getBookingsCollection().updateOne(
        { _id: bookingId, paymentStatus: "unpaid" },
        { $set: { appliedCoupon, updatedAt: new Date() } }
      );
    } catch (error) {
      console.error("appliedCoupon booking update failed:", error);
    }
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

// Safe technician payment-history entry. One entry per completed booking
// owned by the authenticated technician — payment records describe money
// that actually moved; completed-but-unpaid bookings are shown alongside
// so the technician can tell settled from outstanding amounts. Stripe
// internals beyond the Checkout Session id (an identifier, not a secret,
// same convention as the admin payments view), and everything else about
// the customer's account, are deliberately excluded. `amount` is in major
// currency units.
interface TechnicianPaymentEntryDTO {
  bookingId: string;
  serviceTitle: string;
  customerName: string | null;
  amount: number;
  amountMinor: number;
  currency: string;
  status: "paid" | "unpaid";
  reference: string | null;
  completedAt: Date;
  paidAt: Date | null;
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const BOOKING_TECHNICIAN_SORT: Sort = { updatedAt: -1, _id: -1 };

// Aggregation row for per-currency grouping (minor units for payments;
// major units for booking finalAmount sums, converted where merged).
interface CurrencyMinorBucket {
  _id: string;
  total: number;
  count: number;
}

interface CurrencyMajorBucket {
  _id: null;
  total: number;
  count: number;
}

// GET /api/payments/technician — technician only (verifyToken ->
// verifyTechnician). Returns one entry per completed booking owned by the
// authenticated technician, newest activity first (for paid bookings the
// Stripe webhook sets booking.updatedAt to the paid time). Paid vs.
// unpaid is decided from the server-side booking.paymentStatus; payment
// records supply reference, currency and paidAt.
//
// Ownership is enforced exclusively through the JWT-resolved technicianId
// (and the verifyToken database role check); any technicianId in the
// query string is stripped by the schema and ignored.
//
// The summary is computed across the full scoped dataset (identically to
// the visible list, WITHOUT the status filter) directly in MongoDB —
// documents are never loaded into memory in bulk. Amounts are kept per
// currency: summing different currencies into one number would be
// meaningless. Paid entries are settled money from the payments
// collection (unique per booking); unpaid entries contribute the booking
// finalAmount once each, so the two buckets never double-count.
export const listTechnicianPayments = async (
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

  const technicianId = resolveAuthUserId(req);

  if (!technicianId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const parsed = listTechnicianPaymentsQuerySchema.safeParse(req.query);

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
  const status = parsed.data.status;

  // Base scope: completed bookings snapshotted to this technician.
  // "refunded" (if it is ever set outside the payment flow) is treated
  // as unpaid — money was not settled to the technician for it.
  const baseFilter: Filter<Booking> = { technicianId, status: "completed" };
  const listFilter: Filter<Booking> =
    status === "paid"
      ? { ...baseFilter, paymentStatus: "paid" }
      : status === "unpaid"
        ? { ...baseFilter, paymentStatus: { $ne: "paid" } }
        : baseFilter;

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const [items, totalItems] = await Promise.all([
    getBookingsCollection()
      .find(listFilter, {
        projection: {
          serviceTitle: 1,
          customerName: 1,
          paymentStatus: 1,
          finalAmount: 1,
          updatedAt: 1,
        },
      })
      .sort(BOOKING_TECHNICIAN_SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getBookingsCollection().countDocuments(listFilter),
  ]);

  // Fetch payment records only for the page slice — never the whole set.
  const bookingIds = items.map((booking) => booking._id);
  const paymentDocs = bookingIds.length
    ? await getPaymentsCollection()
        .find(
          { bookingId: { $in: bookingIds } },
          {
            projection: {
              bookingId: 1,
              status: 1,
              amount: 1,
              currency: 1,
              paidAt: 1,
              stripeSessionId: 1,
            },
          }
        )
        .toArray()
    : [];

  const paymentsByBookingId = new Map<
    string,
    { succeeded?: Payment; pending?: Payment }
  >();
  for (const payment of paymentDocs) {
    const key = payment.bookingId.toHexString();
    const slot = paymentsByBookingId.get(key) ?? {};
    if (payment.status === "succeeded") {
      slot.succeeded = payment;
    } else if (payment.status === "pending") {
      slot.pending = payment;
    }
    paymentsByBookingId.set(key, slot);
  }

  const entries: TechnicianPaymentEntryDTO[] = items.map((booking) => {
    const paid = booking.paymentStatus === "paid";
    const slot = paymentsByBookingId.get(booking._id.toHexString());
    const succeeded = slot?.succeeded;
    const pending = slot?.pending;
    const reference = succeeded ?? pending;
    const currency =
      stringOrNull(reference?.currency)?.toLowerCase() ?? stripeCurrency;
    const finalAmount =
      typeof booking.finalAmount === "number" &&
      Number.isFinite(booking.finalAmount) &&
      booking.finalAmount >= 0
        ? booking.finalAmount
        : 0;
    // Settled money always comes from the payment record (unique per
    // booking); the booking snapshot is only a fallback for inconsistent
    // datasets. Unpaid amounts are the booking's final charge estimate.
    const amountMinor = paid
      ? succeeded?.amount ?? toMinorUnits(finalAmount, currency)
      : pending?.amount ?? toMinorUnits(finalAmount, currency);

    return {
      bookingId: booking._id.toHexString(),
      serviceTitle: booking.serviceTitle,
      customerName: stringOrNull(booking.customerName),
      amount: fromMinorUnits(amountMinor, currency),
      amountMinor,
      currency,
      status: paid ? "paid" : "unpaid",
      reference: paid ? stringOrNull(succeeded?.stripeSessionId) : null,
      completedAt: booking.updatedAt,
      paidAt: paid ? succeeded?.paidAt ?? null : null,
    };
  });

  const [completedBookings, paidBookings, succeededRows, anomalyRows, unpaidAgg] =
    await Promise.all([
      getBookingsCollection().countDocuments(baseFilter),
      getBookingsCollection().countDocuments({
        ...baseFilter,
        paymentStatus: "paid",
      }),
      // Settled money, grouped per currency (minor units).
      getPaymentsCollection()
        .aggregate<CurrencyMinorBucket>([
          { $match: { technicianId, status: "succeeded" as PaymentStatus } },
          {
            $group: {
              _id: "$currency",
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      // Anomaly guard: bookings marked paid with NO succeeded payment
      // would otherwise vanish from the totals. Add their finalAmount
      // once each — never double-counted, because succeededRows covers
      // only bookings that HAVE one.
      getBookingsCollection()
        .aggregate<CurrencyMajorBucket>([
          { $match: { ...baseFilter, paymentStatus: "paid" } },
          {
            $lookup: {
              from: PAYMENTS_COLLECTION,
              let: { bookingId: "$_id" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$bookingId", "$$bookingId"] },
                        { $eq: ["$status", "succeeded"] },
                      ],
                    },
                  },
                },
              ],
              as: "settled",
            },
          },
          { $match: { settled: { $size: 0 } } },
          {
            $group: {
              _id: null,
              total: { $sum: { $ifNull: ["$finalAmount", 0] } },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      // Unpaid outstanding, summed once per booking.
      getBookingsCollection()
        .aggregate<CurrencyMajorBucket>([
          { $match: { ...baseFilter, paymentStatus: { $ne: "paid" } } },
          {
            $group: {
              _id: null,
              total: { $sum: { $ifNull: ["$finalAmount", 0] } },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
    ]);

  const paidByCurrency = new Map<string, number>();
  for (const row of succeededRows) {
    const currency = String(row._id ?? "").toLowerCase() || stripeCurrency;
    paidByCurrency.set(
      currency,
      (paidByCurrency.get(currency) ?? 0) + row.total
    );
  }

  const anomaly = anomalyRows[0];
  if (anomaly && anomaly.count > 0) {
    paidByCurrency.set(
      stripeCurrency,
      (paidByCurrency.get(stripeCurrency) ?? 0) +
        toMinorUnits(anomaly.total, stripeCurrency)
    );
  }

  const paidAmountByCurrency = [...paidByCurrency.entries()]
    .map(([currency, minor]) => ({
      currency,
      amount: fromMinorUnits(minor, currency),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  // finalAmount carries no currency of its own; outstanding estimates are
  // reported in the configured checkout currency (STRIPE_CURRENCY).
  const unpaidTotal = unpaidAgg[0]?.total ?? 0;
  const unpaidAmountByCurrency =
    unpaidAgg[0] && unpaidAgg[0].count > 0
      ? [{ currency: stripeCurrency, amount: unpaidTotal }]
      : [];

  const unpaidCount = completedBookings - paidBookings;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

  res.status(200).json({
    success: true,
    data: entries,
    summary: {
      totalCompletedBookings: completedBookings,
      paidCount: paidBookings,
      unpaidCount,
      paidAmountByCurrency,
      unpaidAmountByCurrency,
    },
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
//   0. the session must report payment_status "paid" — for asynchronous
//      payment methods (bank debits, BNPL, …) `checkout.session.completed`
//      fires BEFORE the money moves. Those sessions stay pending until
//      `checkout.session.async_payment_succeeded` carries payment_status
//      "paid" (or async_payment_failed retires the pending record).
//   1. the session id must be one we recorded;
//   2. the session metadata booking reference, amount and currency must
//      match our record exactly;
//   3. the booking must still belong to the recorded customer and its
//      settled final amount must price to the recorded minor-unit amount;
//   4. the payment record must still be pending (double delivery is a
//      no-op; the booking is reconciled as a self-heal).
// Mismatches mark the payment failed and leave the booking untouched.
// charge.refunded — reconcile embedded refund records with Stripe's truth.
// Updates invoice/refund status only; never touches amounts. Idempotent:
// conditional arrayFilters keep re-deliveries harmless.
const settleRefundedCharge = async (charge: Stripe.Charge): Promise<void> => {
  const rawIntent = charge.payment_intent;
  const paymentIntentId =
    typeof rawIntent === "string" ? rawIntent : rawIntent?.id;
  if (!paymentIntentId) return;

  const payment = await getPaymentsCollection().findOne({
    stripePaymentIntentId: paymentIntentId,
  });
  if (!payment) return;

  const chargeRefunds =
    (charge as { refunds?: { data?: Array<{ id: string; status?: string }> } })
      .refunds?.data ?? [];
  const confirmedIds = chargeRefunds
    .filter((refund) => refund.status === "succeeded")
    .map((refund) => refund.id);

  if (confirmedIds.length > 0) {
    await getPaymentsCollection().updateOne(
      { _id: payment._id },
      {
        $set: {
          "refunds.$[r].status": "succeeded",
          updatedAt: new Date(),
        },
      },
      {
        arrayFilters: [
          {
            "r.stripeRefundId": { $in: confirmedIds },
            "r.status": { $in: ["pending", "failed"] },
          },
        ],
      }
    );
  }

  const amountRefunded =
    typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
  if (amountRefunded >= payment.amount) {
    await getBookingsCollection().updateOne(
      { _id: payment.bookingId, paymentStatus: { $ne: "refunded" } },
      { $set: { paymentStatus: "refunded", updatedAt: new Date() } }
    );
    await setInvoicePaymentStatus(payment.bookingId, "refunded");
    return;
  }

  // Partial refund — keep the payment status, flag the invoice.
  await setInvoicePaymentStatus(payment.bookingId, "partially_refunded");
};

const settleCompletedSession = async (
  session: Stripe.Checkout.Session
): Promise<void> => {
  const sessionId = toHexOrNull(session?.id);

  if (!sessionId) {
    return;
  }

  // Stripe does not consider the money "paid" for asynchronous methods at
  // the time `completed` fires. Never mark anything paid on that basis —
  // acknowledge and wait for async_payment_succeeded / async_payment_failed.
  if (session.payment_status !== "paid") {
    console.log(
      `[payments] session ${sessionId} completed with payment_status "${session.payment_status ?? "unknown"}" — left pending until the asynchronous payment settles`
    );
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
  const clientReferenceId = toHexOrNull(
    (session as { client_reference_id?: unknown }).client_reference_id
  );
  const sessionAmount =
    typeof session.amount_total === "number" ? session.amount_total : null;
  const sessionCurrency =
    typeof session.currency === "string" ? session.currency.toLowerCase() : null;

  const mismatches: string[] = [];

  if (sessionBookingId !== payment.bookingId.toHexString()) {
    mismatches.push("booking");
  }

  // Cross-check the session's own booking reference against the recorded
  // payment — both must agree, belt and braces on top of metadata.
  if (clientReferenceId && clientReferenceId !== payment.bookingId.toHexString()) {
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

  // Reconcile against the amount we actually charged: the booking's final
  // amount, less any coupon discount this payment carries. The payment's
  // stored `amount` is authoritative for what left the customer's account.
  const appliedDiscount =
    payment.appliedCoupon && typeof payment.appliedCoupon.discountAmount === "number"
      ? payment.appliedCoupon.discountAmount
      : 0;
  const expectedMajor =
    booking && typeof booking.finalAmount === "number" && Number.isFinite(booking.finalAmount)
      ? Math.max(0.01, Math.round((booking.finalAmount - appliedDiscount) * 100) / 100)
      : null;

  const expectedMinor =
    expectedMajor !== null ? toMinorUnits(expectedMajor, payment.currency) : null;

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

  // Reconcile the booking defensively in case a previous attempt died
  // between the payment update and the booking update. Only the delivery
  // that actually flips the booking runs the post-payment fan-out
  // (invoice issuance + timeline/notification), so Stripe redeliveries are
  // idempotent.
  const flip = await getBookingsCollection().updateOne(
    { _id: payment.bookingId, paymentStatus: "unpaid" },
    { $set: { paymentStatus: "paid", updatedAt: paidAt } }
  );

  if (flip.modifiedCount === 0) {
    // Booking was already marked paid — nothing else to do.
    return;
  }

  try {
    const freshBooking = await getBookingsCollection().findOne({
      _id: payment.bookingId,
    });
    if (freshBooking) {
      await ensureInvoiceForBooking(freshBooking._id, claimed ?? undefined);
      await emitBookingEvent(freshBooking, "payment_confirmed", "system");
    }
  } catch (error) {
    // Never let post-payment bookkeeping fail the webhook — Stripe would
    // retry otherwise, and the booking is already correctly marked paid.
    console.error("Post-payment invoice/notification error:", error);
  }
};

// POST /api/payments/webhook — no auth middleware; the Stripe signature is
// verified against the raw request body with STRIPE_WEBHOOK_SECRET. Handled
// events: checkout.session.completed, checkout.session.async_payment_succeeded,
// checkout.session.async_payment_failed, checkout.session.expired. A
// `completed` (or `async_payment_succeeded`) session only settles the
// payment when Stripe reports payment_status "paid". Always answers 200 for
// handled (and uninteresting) events; 400 only for a missing signature or
// raw-body misconfiguration, and 503 when the webhook secret is not
// configured. Processing failures answer 500 so Stripe retries — the
// handler is idempotent.
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
      case "checkout.session.async_payment_succeeded":
        // Asynchronous payment methods (bank debits, BNPL, …) report the
        // money as moved only here. The settlement path is identical —
        // and it re-checks amount, currency, booking and ownership, so a
        // forged or mismatched session can never mark the booking paid.
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
      case "charge.refunded":
        await settleRefundedCharge(event.data.object as Stripe.Charge);
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
