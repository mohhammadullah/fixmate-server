
import type { IndexDescription } from "mongodb";
import { getDB } from "./db.js";
import { SERVICES_COLLECTION } from "../models/service.model.js";
import {
  BOOKINGS_COLLECTION,
  ACTIVE_BOOKING_STATUSES,
} from "../models/booking.model.js";
import { USERS_COLLECTION } from "../models/technician-application.model.js";
import { PAYMENTS_COLLECTION } from "../models/payment.model.js";

// Index definitions for the `services` collection.
//
// Notes:
// - The { approvalStatus: 1, availabilityStatus: 1, category: 1 } compound
//   index supports public discovery queries and can also serve queries on
//   approvalStatus alone (MongoDB uses leftmost prefixes), so a standalone
//   approvalStatus index would be redundant and is intentionally omitted.
// - category appears last in the compound index and on its own supports
//   category browsing; it is not redundant with the compound.
// - createdAt (descending) supports newest-first listings.
export const servicesIndexes: IndexDescription[] = [
  {
    key: { technicianId: 1 },
    name: "services_technicianId_1",
  },
  {
    key: { category: 1 },
    name: "services_category_1",
  },
  {
    key: { createdAt: -1 },
    name: "services_createdAt_-1",
  },
  {
    key: { approvalStatus: 1, availabilityStatus: 1, category: 1 },
    name: "services_approvalStatus_1_availabilityStatus_1_category_1",
  },
];

// Index definitions for the `bookings` collection.
//
// The partial unique index is the authoritative guard against duplicate
// ACTIVE bookings for the same (customerId, serviceId). Only bookings whose
// status is requested/accepted/in-progress are covered, so completed,
// rejected or cancelled bookings never block a fresh booking. MongoDB
// 8.0.x supports partialFilterExpression for unique indexes. Enforced at
// the database level, it cannot be bypassed by concurrent requests racing
// past an application-level pre-check; violations surface as error 11000.
// - Review subdocuments drive the public "latest reviews" feed (sorted by
//   review.createdAt) and the service rating aggregations (filtered by
//   serviceId). Both partial indexes only cover bookings that carry a
//   review, so their size stays proportional to actual review volume.
// - The schedule unique partial index is the authoritative guard against
//   concurrent technician slot claims: two bookings for the same technician
//   on the same date + hourly slot in an ACTIVE status cannot both exist.
//   Combined with hourly (:00-aligned) slot enforcement, it eliminates
//   double-booking even under races — violations surface as error 11000.
// - The coupon partial index supports per-customer redemption-limit checks
//   (count of this customer's coupon redemptions) without collection scans.
export const bookingIndexes: IndexDescription[] = [
  {
    key: { customerId: 1, serviceId: 1 },
    name: "bookings_active_customer_service_unique",
    unique: true,
    partialFilterExpression: {
      status: { $in: [...ACTIVE_BOOKING_STATUSES] },
    },
  },
  {
    key: { technicianId: 1, status: 1 },
    name: "bookings_technicianId_1_status_1",
  },
  {
    key: { customerId: 1, status: 1 },
    name: "bookings_customerId_1_status_1",
  },
  {
    key: { createdAt: -1 },
    name: "bookings_createdAt_-1",
  },
  {
    key: { "review.createdAt": -1 },
    name: "bookings_review_createdAt_-1",
    partialFilterExpression: { review: { $exists: true } },
  },
  {
    key: { serviceId: 1 },
    name: "bookings_serviceId_1_review",
    partialFilterExpression: { review: { $exists: true } },
  },
  // The homepage statistics and popular-services aggregations match on
  // review.rating (existence + 1–5 bounds) across all reviewed bookings,
  // with no serviceId/createdAt predicate — neither partial index above can
  // serve that. This one keeps those scans bounded to reviewed bookings.
  {
    key: { "review.rating": 1 },
    name: "bookings_review_rating_1",
    partialFilterExpression: { review: { $exists: true } },
  },
  {
    key: { technicianId: 1, "schedule.date": 1, "schedule.slotStart": 1 },
    name: "bookings_technician_schedule_active_unique",
    unique: true,
    partialFilterExpression: {
      schedule: { $exists: true },
      status: { $in: [...ACTIVE_BOOKING_STATUSES] },
    },
  },
  {
    key: { customerId: 1, "appliedCoupon.code": 1 },
    name: "bookings_customerId_1_couponCode_1",
    partialFilterExpression: { appliedCoupon: { $exists: true } },
  },
];

// Index definitions for the `payments` collection.
//
// - At most one pending checkout may exist per booking, enforced by the
//   partial unique index (concurrent requests race to insert and the
//   loser matches no pending record and simply reuses it).
// - At most one succeeded payment per booking, so a booking can never be
//   settled twice, even if two sessions were somehow opened.
// - stripeSessionId is unique across the collection; it is absent while a
//   Checkout Session is being created, so the index is sparse.
// - { customerId: 1, createdAt: -1 } supports the payment-history listing.
export const paymentIndexes: IndexDescription[] = [
  {
    key: { bookingId: 1 },
    name: "payments_one_pending_per_booking_unique",
    unique: true,
    partialFilterExpression: { status: "pending" },
  },
  {
    key: { bookingId: 1 },
    name: "payments_one_succeeded_per_booking_unique",
    unique: true,
    partialFilterExpression: { status: "succeeded" },
  },
  {
    key: { stripeSessionId: 1 },
    name: "payments_stripeSessionId_unique_sparse",
    unique: true,
    sparse: true,
  },
  {
    key: { customerId: 1, createdAt: -1 },
    name: "payments_customerId_1_createdAt_-1",
  },
  // Supports the admin payments listing (newest-first, optional status
  // filter). Filtered or unfiltered alike.
  {
    key: { status: 1, createdAt: -1 },
    name: "payments_status_1_createdAt_-1",
  },
  {
    key: { createdAt: -1 },
    name: "payments_createdAt_-1",
  },
  // Supports the technician payments view: per-booking payment lookups
  // (including failed/expired records, which the partial indexes cannot
  // serve) and the per-currency settled-money aggregation by technician.
  {
    key: { bookingId: 1 },
    name: "payments_bookingId_1",
  },
  {
    key: { technicianId: 1, status: 1 },
    name: "payments_technicianId_1_status_1",
  },
];

// Index on the `user` collection supporting admin application listings.
// No new collection is created — the application is a subdocument.
export const userIndexes: IndexDescription[] = [
  {
    key: { "technicianApplication.status": 1, "technicianApplication.submittedAt": -1 },
    name: "user_technicianApplication_status_1_submittedAt_-1",
  },
];

// Creates the indexes once, at startup. createIndexes is idempotent, so
// re-running against identical definitions is a no-op on the server side.
export const ensureIndexes = async (): Promise<string[]> => {
  const db = getDB();

  const [serviceIndexNames, bookingIndexNames, paymentIndexNames, userIndexNames] =
    await Promise.all([
      db.collection(SERVICES_COLLECTION).createIndexes(servicesIndexes),
      db.collection(BOOKINGS_COLLECTION).createIndexes(bookingIndexes),
      db.collection(PAYMENTS_COLLECTION).createIndexes(paymentIndexes),
      db.collection(USERS_COLLECTION).createIndexes(userIndexes),
    ]);

  return [
    ...serviceIndexNames,
    ...bookingIndexNames,
    ...paymentIndexNames,
    ...userIndexNames,
  ];
};
