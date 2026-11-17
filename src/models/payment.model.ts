
import type { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

export const PAYMENTS_COLLECTION = "payments";

export const PAYMENT_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "expired",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

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
  createdAt: Date;
  updatedAt: Date;
  paidAt?: Date;
}

export const getPaymentsCollection = (): Collection<Payment> =>
  getDB().collection<Payment>(PAYMENTS_COLLECTION);
