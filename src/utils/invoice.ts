
import { ObjectId, type Document } from "mongodb";
import type { Booking } from "../models/booking.model.js";
import type { Payment } from "../models/payment.model.js";
import { getBookingsCollection } from "../models/booking.model.js";
import { env } from "../config/env.js";
import type { BookingInvoice } from "../models/booking-extras.model.js";

/**
 * Digital invoice issuance. Invoice snapshots are immutable once written —
 * they are never edited by users (no endpoint accepts invoice input). The
 * snapshot is derived exclusively from server-side records (booking + the
 * succeeded payment, when present).
 *
 * Invoice is created lazily: on Stripe webhook payment success, or
 * on-demand via the invoice endpoint for completed-but-unpaid bookings.
 */

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const buildInvoiceNumber = (bookingId: ObjectId, issuedAt: Date): string => {
  const year = issuedAt.getUTCFullYear();
  const month = String(issuedAt.getUTCMonth() + 1).padStart(2, "0");
  return `INV-${year}${month}-${bookingId.toHexString().slice(-8).toUpperCase()}`;
};

export const createInvoice = (
  booking: Booking,
  payment: Payment | undefined,
  issuedAt = new Date()
): BookingInvoice => {
  const currency = payment?.currency ?? env.STRIPE_CURRENCY;
  const serviceAmount = typeof booking.finalAmount === "number" && Number.isFinite(booking.finalAmount)
    ? booking.finalAmount
    : 0;

  const applied = booking.appliedCoupon ?? payment?.appliedCoupon;
  const discountAmount = applied
    ? Math.min(
        Math.max(0, round2(applied.discountAmount)),
        round2(serviceAmount)
      )
    : 0;

  const taxable = Math.max(0, serviceAmount - discountAmount);
  // Tax model: inclusive. Total always equals the amount actually charged
  // (serviceAmount − discount); tax is an informational breakdown of that
  // total (rate applied on the gross figure), never an addition on top —
  // so the invoice can never drift from the Stripe-chargeable amount.
  const totalAmount = round2(taxable);
  const taxAmount =
    env.INVOICE_TAX_RATE > 0 ? round2((totalAmount * env.INVOICE_TAX_RATE) / (1 + env.INVOICE_TAX_RATE)) : 0;

  const invoice: BookingInvoice = {
    number: buildInvoiceNumber(booking._id, issuedAt),
    issuedAt,
    currency,
    serviceAmount: round2(serviceAmount),
    discountAmount,
    ...(applied ? { discountCode: applied.code } : {}),
    taxAmount,
    totalAmount,
    paymentStatus: booking.paymentStatus === "paid" ? "paid" : "unpaid",
    ...(payment?.paidAt ? { paidAt: payment.paidAt } : {}),
    ...(payment?.stripeSessionId ? { paymentReference: payment.stripeSessionId } : {}),
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    technicianName: booking.technicianName,
    serviceTitle: booking.serviceTitle,
    serviceCategory: booking.serviceCategory,
    serviceLocation: booking.serviceLocation,
    bookingReference: booking._id.toHexString(),
  };

  return invoice;
};

/**
 * Idempotently ensure a completed booking has its invoice. Creates it when
 * absent; updates only mutable status fields (paymentStatus / paidAt /
 * paymentReference) when the booking later becomes paid. Never rewrites
 * amounts once set.
 */
export const ensureInvoiceForBooking = async (
  bookingId: ObjectId,
  payment?: Payment
): Promise<BookingInvoice | null> => {
  const booking = await getBookingsCollection().findOne({ _id: bookingId });
  if (!booking || booking.status !== "completed") return null;

  if (!booking.invoice) {
    const invoice = createInvoice(booking, payment);
    const update: Document = {
      $set: { invoice, updatedAt: new Date() },
    };
    // Pin the absence of invoice to avoid racing two creators.
    const result = await getBookingsCollection().updateOne(
      { _id: bookingId, invoice: { $exists: false } },
      update
    );
    if (result.modifiedCount === 1 || result.matchedCount === 1) {
      return booking.invoice ?? invoice;
    }
    // Another writer won — re-read and return theirs.
    const fresh = await getBookingsCollection().findOne({ _id: bookingId });
    return fresh?.invoice ?? null;
  }

  // Invoice exists — reconcile paid-state fields only (never amounts).
  const paid = payment?.status === "succeeded";
  if (paid && booking.invoice.paymentStatus !== "paid") {
    const update: Document = {
      $set: {
        "invoice.paymentStatus": "paid",
        ...(payment?.paidAt ? { "invoice.paidAt": payment.paidAt } : {}),
        ...(payment?.stripeSessionId ? { "invoice.paymentReference": payment.stripeSessionId } : {}),
        updatedAt: new Date(),
      },
    };
    await getBookingsCollection().updateOne(
      { _id: bookingId, "invoice.paymentStatus": { $ne: "paid" } },
      update
    );
    return {
      ...booking.invoice,
      paymentStatus: "paid",
      ...(payment?.paidAt ? { paidAt: payment.paidAt } : {}),
      ...(payment?.stripeSessionId ? { paymentReference: payment.stripeSessionId } : {}),
    };
  }

  return booking.invoice;
};

/** Mark an invoice's paymentStatus without touching amounts. */
export const setInvoicePaymentStatus = async (
  bookingId: ObjectId,
  status: "unpaid" | "paid" | "refunded" | "partially_refunded"
): Promise<void> => {
  await getBookingsCollection().updateOne(
    { _id: bookingId, invoice: { $exists: true } },
    { $set: { "invoice.paymentStatus": status, updatedAt: new Date() } }
  );
};
