
import type { Response } from "express";
import { ObjectId, type Document } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getDB } from "../config/db.js";
import { USERS_COLLECTION } from "../models/technician-application.model.js";
import { getServicesCollection } from "../models/service.model.js";
import { getBookingsCollection } from "../models/booking.model.js";
import { getPaymentsCollection } from "../models/payment.model.js";
import { analyticsQuerySchema } from "../validators/features.validator.js";

// Admin analytics: everything computed with MongoDB aggregation pipelines
// over the existing collections. No new collection. Admin-role gate is
// enforced by the route; date range is bounded (required from/to or
// rolling last 30 days). Revenue is ALWAYS reported per currency — we
// never sum across currencies without a verified FX source.

const toUtcMidnight = (isoDate: string, endOfDay = false): Date => {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (endOfDay) d.setUTCHours(23, 59, 59, 999);
  return d;
};

const defaultRange = (): { from: Date; to: Date } => {
  const to = new Date();
  to.setUTCHours(23, 59, 59, 999);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to };
};

export const getAdminAnalytics = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const parsed = analyticsQuerySchema.safeParse(req.query);
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

  const range = parsed.data.from
    ? { from: toUtcMidnight(parsed.data.from), to: toUtcMidnight(parsed.data.to ?? parsed.data.from, true) }
    : defaultRange();
  const { from, to } = range;

  const servicesCol = getServicesCollection();
  const bookingsCol = getBookingsCollection();
  const paymentsCol = getPaymentsCollection();
  const usersCol = getDB().collection(USERS_COLLECTION);

  const [
    usersAgg,
    techStatusAgg,
    servicesAgg,
    bookingsAgg,
    paymentsAgg,
    couponAgg,
    refundsAgg,
    techniciansAgg,
    bookingsTrendAgg,
    revenueTrendAgg,
    recentAgg,
  ] = await Promise.all([
    // Users by role.
    usersCol
      .aggregate<{ _id: string; count: number }>([
        { $group: { _id: { $ifNull: ["$role", "customer"] }, count: { $sum: 1 } } },
      ])
      .toArray(),

    // Technicians by availability status (embedded availability config).
    usersCol
      .aggregate<{ _id: string; count: number }>([
        { $match: { role: "technician" } },
        {
          $group: {
            _id: { $ifNull: ["$availability.status", "available"] },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),

    // Services by approval status (all-time snapshot).
    servicesCol
      .aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$approvalStatus", count: { $sum: 1 } } },
      ])
      .toArray(),

    // Bookings all-time status distribution.
    bookingsCol
      .aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
      .toArray(),

    // Payments in range: counts by status + per-currency amounts.
    paymentsCol
      .aggregate<{
        _id: { status: string; currency: string };
        count: number;
        totalMinor: number;
      }>([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { status: "$status", currency: "$currency" },
            count: { $sum: 1 },
            totalMinor: { $sum: "$amount" },
          },
        },
      ])
      .toArray(),

    // Coupon redemptions in range (from embedded appliedCoupon on payments).
    paymentsCol
      .aggregate<{
        _id: string;
        count: number;
        discountMinor: number;
      }>([
        {
          $match: {
            appliedCoupon: { $exists: true },
            status: "succeeded",
            createdAt: { $gte: from, $lte: to },
          },
        },
        {
          $group: {
            _id: { $ifNull: ["$appliedCoupon.currency", "$currency"] },
            count: { $sum: 1 },
            discountMinor: {
              // discountAmount snapshot is stored in MAJOR units; convert inline.
              $sum: { $multiply: [{ $ifNull: ["$appliedCoupon.discountAmount", 0] }, 100] },
            },
          },
        },
      ])
      .toArray(),

    // Refunds in range: counts + per-currency totals (minor units).
    paymentsCol
      .aggregate<{
        _id: { currency: string; status: string };
        count: number;
        totalMinor: number;
      }>([
        { $match: { refunds: { $exists: true, $not: { $size: 0 } } } },
        { $unwind: "$refunds" },
        {
          $match: {
            "refunds.requestedAt": { $gte: from, $lte: to },
          },
        },
        {
          $group: {
            _id: { currency: "$refunds.currency", status: "$refunds.status" },
            count: { $sum: 1 },
            totalMinor: { $sum: "$refunds.amountMinor" },
          },
        },
      ])
      .toArray(),

    // Technician performance in range: completed bookings + revenue per currency.
    bookingsCol
      .aggregate<{
        _id: ObjectId;
        completed: number;
        ratings: number[];
      }>([
        { $match: { status: "completed", updatedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: "$technicianId",
            completed: { $sum: 1 },
            ratings: { $push: "$review.rating" },
          },
        },
        { $sort: { completed: -1 } },
        { $limit: 10 },
      ])
      .toArray(),

    // Booking volume per day (UTC).
    bookingsCol
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            createdAt: { $gte: from, $lte: to },
          },
        },
        {
          $project: {
            day: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" },
            },
          },
        },
        { $group: { _id: "$day", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),

    // Revenue per day per currency (succeeded payments).
    paymentsCol
      .aggregate<{ _id: { day: string; currency: string }; totalMinor: number }>([
        {
          $match: {
            status: "succeeded",
            createdAt: { $gte: from, $lte: to },
          },
        },
        {
          $project: {
            day: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" },
            },
            currency: 1,
            amount: 1,
          },
        },
        {
          $group: {
            _id: { day: "$day", currency: "$currency" },
            totalMinor: { $sum: "$amount" },
          },
        },
        { $sort: { "_id.day": 1 } },
      ])
      .toArray(),

    // Recent activity: latest timeline events across bookings in range.
    bookingsCol
      .aggregate<{
        _id: ObjectId;
        timeline: { type: string; at: Date; by: string };
        serviceTitle?: string;
      }>([
        {
          $match: {
            "timeline.at": { $gte: from, $lte: to },
          },
        },
        { $unwind: "$timeline" },
        { $match: { "timeline.at": { $gte: from, $lte: to } } },
        { $sort: { "timeline.at": -1 } },
        { $limit: 20 },
        {
          $project: {
            _id: 1,
            serviceTitle: 1,
            timeline: {
              type: "$timeline.type",
              at: "$timeline.at",
              by: "$timeline.by",
            },
          },
        },
      ])
      .toArray(),
  ]);

  const users = { total: 0, customers: 0, technicians: 0, admins: 0 };
  for (const row of usersAgg) {
    const count = row.count;
    users.total += count;
    if (row._id === "customer") users.customers = count;
    else if (row._id === "technician") users.technicians = count;
    else if (row._id === "admin") users.admins = count;
  }

  const availability = { available: 0, busy: 0 };
  for (const row of techStatusAgg) {
    availability[row._id === "busy" ? "busy" : "available"] = row.count;
  }

  const services = { approved: 0, pending: 0, rejected: 0 };
  for (const row of servicesAgg) {
    const key = row._id as keyof typeof services;
    if (key in services) services[key] = row.count;
  }

  const bookings: Record<string, number> = {};
  let bookingsTotal = 0;
  for (const row of bookingsAgg) {
    bookings[row._id] = row.count;
    bookingsTotal += row.count;
  }

  // Per-currency revenue breakdown (never summed across currencies).
  const revenueByCurrency = new Map<
    string,
    { currency: string; succeededMinor: number; succeededCount: number; pendingMinor: number; pendingCount: number; failedCount: number }
  >();
  for (const row of paymentsAgg) {
    const currency = row._id.currency;
    const bucket = revenueByCurrency.get(currency) ?? {
      currency,
      succeededMinor: 0,
      succeededCount: 0,
      pendingMinor: 0,
      pendingCount: 0,
      failedCount: 0,
    };
    if (row._id.status === "succeeded") {
      bucket.succeededMinor += row.totalMinor;
      bucket.succeededCount += row.count;
    } else if (row._id.status === "pending") {
      bucket.pendingMinor += row.totalMinor;
      bucket.pendingCount += row.count;
    } else {
      bucket.failedCount += row.count;
    }
    revenueByCurrency.set(currency, bucket);
  }

  const refundsByCurrency = new Map<
    string,
    { currency: string; succeededMinor: number; succeededCount: number; pendingCount: number; failedCount: number; rejectedCount: number }
  >();
  for (const row of refundsAgg) {
    const currency = row._id.currency;
    const bucket = refundsByCurrency.get(currency) ?? {
      currency,
      succeededMinor: 0,
      succeededCount: 0,
      pendingCount: 0,
      failedCount: 0,
      rejectedCount: 0,
    };
    if (row._id.status === "succeeded") {
      bucket.succeededMinor += row.totalMinor;
      bucket.succeededCount += row.count;
    } else if (row._id.status === "pending") {
      bucket.pendingCount += row.count;
    } else if (row._id.status === "failed") {
      bucket.failedCount += row.count;
    } else {
      bucket.rejectedCount += row.count;
    }
    refundsByCurrency.set(currency, bucket);
  }

  // Net revenue per currency = succeeded payments − succeeded refunds.
  const netRevenueByCurrency = [...revenueByCurrency.values()].map((bucket) => {
    const refunds = refundsByCurrency.get(bucket.currency);
    const refundMinor = refunds?.succeededMinor ?? 0;
    return {
      currency: bucket.currency,
      succeededMinor: bucket.succeededMinor,
      succeededCount: bucket.succeededCount,
      refundMinor,
      refundCount: refunds?.succeededCount ?? 0,
      netMinor: Math.max(0, bucket.succeededMinor - refundMinor),
      pendingMinor: bucket.pendingMinor,
      pendingCount: bucket.pendingCount,
      failedCount: bucket.failedCount,
    };
  });

  const couponTotals = { redemptions: 0, discountMinorByCurrency: [] as { currency: string; discountMinor: number }[] };
  for (const row of couponAgg) {
    couponTotals.redemptions += row.count;
    couponTotals.discountMinorByCurrency.push({ currency: row._id, discountMinor: Math.round(row.discountMinor) });
  }

  // Technician performance: completed jobs, average rating, ratings count.
  const techIds = techniciansAgg.map((row) => row._id);
  const userDocs = await usersCol
    .find({ _id: { $in: techIds } }, { projection: { name: 1 } })
    .toArray();
  const nameById = new Map(userDocs.map((doc) => [doc._id.toHexString(), doc.name]));

  const technicianPerformance = techniciansAgg.map((row) => {
    const ratings = (row.ratings ?? []).filter(
      (value): value is number => typeof value === "number"
    );
    const avg = ratings.length > 0
      ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 10) / 10
      : null;
    return {
      technicianId: row._id.toHexString(),
      name: nameById.get(row._id.toHexString()) ?? "Unknown technician",
      completed: row.completed,
      averageRating: avg,
      reviewCount: ratings.length,
    };
  });

  const bookingTrend = bookingsTrendAgg.map((row) => ({ date: row._id, count: row.count }));
  const revenueTrend = revenueTrendAgg.map((row) => ({
    date: row._id.day,
    currency: row._id.currency,
    netMinor: row.totalMinor,
  }));

  const recentActivity = recentAgg.slice(0, 10).map((row) => ({
    bookingId: row._id.toHexString(),
    serviceTitle: row.serviceTitle,
    type: row.timeline.type,
    at: row.timeline.at,
    by: row.timeline.by,
  }));

  res.status(200).json({
    success: true,
    data: {
      range: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      users: {
        ...users,
        activeTechnicians: availability.available,
        busyTechnicians: availability.busy,
      },
      services,
      bookings: {
        total: bookingsTotal,
        byStatus: bookings,
        completed: bookings["completed"] ?? 0,
        cancelled: bookings["cancelled"] ?? 0,
      },
      payments: {
        byCurrency: netRevenueByCurrency,
        // Global refund totals — reported per currency only. We deliberately
        // do NOT sum currencies without a verified FX source.
        totalRefundedMinorByCurrency: [...refundsByCurrency.values()].map((bucket) => ({
          currency: bucket.currency,
          succeededMinor: bucket.succeededMinor,
          succeededCount: bucket.succeededCount,
          pendingCount: bucket.pendingCount,
          failedCount: bucket.failedCount,
          rejectedCount: bucket.rejectedCount,
        })),
      },
      coupons: couponTotals,
      technicianPerformance,
      trends: {
        bookingsPerDay: bookingTrend,
        revenuePerDay: revenueTrend,
      },
      recentActivity,
    },
  });
};
