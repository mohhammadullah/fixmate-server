
import type { Response } from "express";
import { ObjectId } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getBookingsCollection } from "../models/booking.model.js";
import { OBJECT_ID_HEX_REGEX } from "../validators/booking.validator.js";
import { toPublicTimeline } from "../utils/timeline.js";

/**
 * GET /api/admin/bookings/:id — admin only. Full operational view of a
 * booking (including the server-written timeline and the invoice snapshot,
 * when issued). Never exposes internal-only Mongo fields; customer/
 * technician emails are visible to admins by design (user management is an
 * admin function).
 */
export const getAdminBooking = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (typeof raw !== "string" || !OBJECT_ID_HEX_REGEX.test(raw)) {
    res.status(400).json({ success: false, message: "Invalid booking id." });
    return;
  }

  const booking = await getBookingsCollection().findOne({ _id: new ObjectId(raw) });
  if (!booking) {
    res.status(404).json({ success: false, message: "Booking not found." });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      id: booking._id.toHexString(),
      service: {
        title: booking.serviceTitle,
        category: booking.serviceCategory,
        location: booking.serviceLocation,
        image: booking.serviceImage,
        hourlyRate: booking.hourlyRate,
      },
      customer: {
        name: booking.customerName,
        email: booking.customerEmail,
      },
      technician: {
        name: booking.technicianName,
        email: booking.technicianEmail,
      },
      problemDescription: booking.problemDescription,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      hourlyRate: booking.hourlyRate,
      finalAmount: booking.finalAmount,
      schedule: booking.schedule,
      invoice: booking.invoice
        ? {
            number: booking.invoice.number,
            issuedAt: booking.invoice.issuedAt,
            currency: booking.invoice.currency,
            serviceAmount: booking.invoice.serviceAmount,
            discountAmount: booking.invoice.discountAmount,
            discountCode: booking.invoice.discountCode,
            taxAmount: booking.invoice.taxAmount,
            totalAmount: booking.invoice.totalAmount,
            paymentStatus: booking.invoice.paymentStatus,
            paidAt: booking.invoice.paidAt,
            paymentReference: booking.invoice.paymentReference,
            bookingReference: booking.invoice.bookingReference,
          }
        : undefined,
      timeline: toPublicTimeline(booking.timeline),
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
    },
  });
};
