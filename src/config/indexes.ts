
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
