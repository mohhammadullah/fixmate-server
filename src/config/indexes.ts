
import type { Db, IndexDescription } from "mongodb";
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
// - Bookings that carry an applied coupon. Supports customer-scoped booking
//   lookups involving applied coupons without collection scans. Settled
//   per-customer coupon redemption counting is served by the payments index
//   `payments_customerId_1_status_1_appliedCoupon_code_1`.
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
  // Supports per-customer settled coupon redemption counting.
  {
    key: { customerId: 1, status: 1, "appliedCoupon.code": 1 },
    name: "payments_customerId_1_status_1_appliedCoupon_code_1",
    partialFilterExpression: { "appliedCoupon.code": { $exists: true } },
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

// Unique indexes that enforce product invariants. If any of these cannot be
// created, the server must not accept traffic: booking/slot/payment races
// would otherwise be possible.
export const CRITICAL_INDEX_NAMES = [
  "bookings_active_customer_service_unique",
  "bookings_technician_schedule_active_unique",
  "payments_one_pending_per_booking_unique",
  "payments_one_succeeded_per_booking_unique",
  "payments_stripeSessionId_unique_sparse",
] as const;

/** Actionable startup failure. Never deletes or rewrites existing records. */
export class IndexStartupError extends Error {
  readonly collection: string;
  readonly indexName: string | null;
  readonly remediation: string;

  constructor(args: {
    collection: string;
    indexName: string | null;
    mongoMessage: string;
    remediation: string;
  }) {
    super(
      `MongoDB index startup failed on collection "${args.collection}"` +
        `${args.indexName ? ` (index "${args.indexName}")` : ""}: ` +
        `${args.mongoMessage}\n${args.remediation}`
    );
    this.name = "IndexStartupError";
    this.collection = args.collection;
    this.indexName = args.indexName;
    this.remediation = args.remediation;
  }
}

/** Convert a createIndexes failure into a message operators can act on. */
export const describeIndexFailure = (
  collection: string,
  error: unknown
): IndexStartupError => {
  const mongoMessage = error instanceof Error ? error.message : String(error);
  const indexName = mongoMessage.match(/index:\s*([^\s,]+)/i)?.[1] ?? null;
  const duplicate = /E11000|duplicate key/i.test(mongoMessage);
  const remediation = duplicate
    ? `Existing ${collection} documents violate the unique index` +
      `${indexName ? ` "${indexName}"` : ""}. Inspect the collection in MongoDB, ` +
      `identify the duplicate key reported above, and manually merge or remove ` +
      `the conflicting documents. This server never deletes or modifies records ` +
      `to make index creation succeed. Resolve the duplicates, then restart.`
    : `Check MongoDB connectivity, write permissions and the index definition, ` +
      `then restart. The server will not accept traffic until indexes exist.`;
  return new IndexStartupError({ collection, indexName, mongoMessage, remediation });
};

/**
 * Creates the indexes once, at startup. createIndexes is idempotent, so
 * re-running against identical definitions is a no-op on the server side.
 * Failures are fatal: callers must refuse to serve traffic.
 */
export const ensureIndexes = async (db: Db = getDB()): Promise<string[]> => {
  const groups = [
    [SERVICES_COLLECTION, servicesIndexes],
    [BOOKINGS_COLLECTION, bookingIndexes],
    [PAYMENTS_COLLECTION, paymentIndexes],
    [USERS_COLLECTION, userIndexes],
  ] as const;

  const created: string[] = [];
  for (const [collection, definitions] of groups) {
    try {
      created.push(...(await db.collection(collection).createIndexes([...definitions])));
    } catch (error) {
      throw describeIndexFailure(collection, error);
    }
  }

  const existing = new Set(created);
  const missing = CRITICAL_INDEX_NAMES.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new IndexStartupError({
      collection: "multiple",
      indexName: missing[0],
      mongoMessage: `required unique indexes are missing: ${missing.join(", ")}`,
      remediation:
        "Check MongoDB index creation permissions and retry. The server will not accept traffic without these indexes.",
    });
  }

  return created;
};
