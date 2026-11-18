
import type { Response } from "express";
import { ObjectId } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getBookingsCollection } from "../models/booking.model.js";
import { getPaymentsCollection } from "../models/payment.model.js";
import { bookingIdParamSchema } from "../validators/features.validator.js";
import { ensureInvoiceForBooking } from "../utils/invoice.js";

/**
 * GET /api/bookings/:id/invoice — owner, assigned technician, or admin.
 * Creates the invoice lazily on first read (eligible = completed booking).
 * Returns a print-friendly DTO; amounts are immutable server snapshots.
 */
export const getBookingInvoice = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsedId = bookingIdParamSchema.safeParse(rawId);
  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid booking id." });
    return;
  }

  const bookingId = new ObjectId(parsedId.data);
  const booking = await getBookingsCollection().findOne({ _id: bookingId });
  if (!booking) {
    res.status(404).json({ success: false, message: "Booking not found." });
    return;
  }

  const isOwner = booking.customerId.toHexString() === req.user.id;
  const isTechnician = booking.technicianId.toHexString() === req.user.id;
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isTechnician && !isAdmin) {
    // Another customer's booking is indistinguishable from a missing one.
    res.status(404).json({ success: false, message: "Booking not found." });
    return;
  }

  if (booking.status !== "completed") {
    res.status(409).json({
      success: false,
      message: "An invoice is available once the booking is completed.",
    });
    return;
  }

  // Load the succeeded payment (if any) so a late first read still yields a
  // fully-paid invoice snapshot.
  const payment = await getPaymentsCollection().findOne(
    { bookingId, status: "succeeded" },
    { projection: { appliedCoupon: 1, currency: 1, paidAt: 1, stripeSessionId: 1, status: 1 } }
  );

  const invoice = await ensureInvoiceForBooking(bookingId, payment ?? undefined);
  if (!invoice) {
    res.status(500).json({ success: false, message: "Invoice could not be issued." });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      number: invoice.number,
      issuedAt: invoice.issuedAt,
      currency: invoice.currency,
      serviceAmount: invoice.serviceAmount,
      discountAmount: invoice.discountAmount,
      discountCode: invoice.discountCode,
      taxAmount: invoice.taxAmount,
      totalAmount: invoice.totalAmount,
      paymentStatus: invoice.paymentStatus,
      paidAt: invoice.paidAt,
      paymentReference: invoice.paymentReference,
      customerName: invoice.customerName,
      ...(isOwner || isAdmin ? { customerEmail: invoice.customerEmail } : {}),
      // Masked surrogate reference for printing — customer sees booking ref.
      bookingReference: invoice.bookingReference,
      technicianName: invoice.technicianName,
      serviceTitle: invoice.serviceTitle,
      serviceCategory: invoice.serviceCategory,
      serviceLocation: invoice.serviceLocation,
    },
  });
};
