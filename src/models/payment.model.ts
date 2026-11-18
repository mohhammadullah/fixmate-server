
import type { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import type { AppliedCoupon } from "./booking-extras.model.js";

export const PAYMENTS_COLLECTION = "payments";

export const PAYMENT_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "expired",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "rejected",
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

// Embedded refund record on the payment document. Stripe is the source of
// truth for outcome; webhook + direct API responses drive status. Capped at
// MAX_REFUNDS_PER_PAYMENT entries to bound document size.
export const MAX_REFUNDS_PER_PAYMENT = 10;

export interface PaymentRefund {
  /** Server-generated hex id (ObjectId). */
  id: string;
  /** Minor units. */
  amountMinor: number;
  currency: string;
  /** Customer-supplied reason; sanitized server-side before storage. */
  reason: string;
  status: RefundStatus;
  /** Idempotency key used for the Stripe refund call. */
  idempotencyKey: string;
  /** Stripe refund id once created; grounds status reconciliation. */
  stripeRefundId?: string;
  requestedAt: Date;
  decidedAt?: Date;
  /** Admin who approved/rejected; undefined while pending. */
  decidedBy?: ObjectId;
  decisionNote?: string;
  failureReason?: string;
}

// Stripe Checkout Session payment record. `amount` is always stored in
// the currency's smallest unit (minor units, as sent to Stripe) — never a
// float major-unit value. `currency` is the lowercase ISO 4217 code.
// `checkoutUrl` is Stripe-hosted and reusable until the session expires;
// it is not a secret.
export interface Payment {
  _id: ObjectId;
  bookingId: ObjectId;
  customerId: ObjectId;
  technicianId: ObjectId;
  // Absent while the Checkout Session is being created (Stripe-first
  // insert order); set before the HTTP response completes.
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  checkoutUrl?: string;
  // ISO 8601 expiry reported by Stripe for the Checkout Session.
  expiresAt?: Date;
  amount: number;
  currency: string;
  status: PaymentStatus;
  // Coupon redemption recorded atomically at checkout creation.
  appliedCoupon?: AppliedCoupon;
  // Embedded refund records — created on request, decided/settled by admin
  // and Stripe webhooks. Capped at MAX_REFUNDS_PER_PAYMENT.
  refunds?: PaymentRefund[];
  createdAt: Date;
  updatedAt: Date;
  paidAt?: Date;
}

export const getPaymentsCollection = (): Collection<Payment> =>
  getDB().collection<Payment>(PAYMENTS_COLLECTION);
