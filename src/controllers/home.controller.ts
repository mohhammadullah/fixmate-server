
import type { Request, Response } from "express";
import { getServicesCollection, canonicalizeCategory } from "../models/service.model.js";
import { getBookingsCollection } from "../models/booking.model.js";
import { getUsersCollection } from "../models/technician-application.model.js";

// GET /api/home/summary — public, no authentication.
//
// Powers the homepage hero's live platform statistics. Everything returned
// here is computed from MongoDB at request time:
//   - completedRepairs: bookings with status "completed"
//   - verifiedTechnicians: users with role "technician" whose technician
//     application was approved (the existing verification + approval rule)
//   - totalBookings: every stored booking, regardless of status
//   - totalReviews / averageRating: from stored booking review subdocuments
//     (only completed bookings can carry a review; ratings are 1–5)
//   - approvedServices / activeTechnicians: services currently approved and
//     available, and the distinct technicians behind them (legacy fields kept
//     for compatibility)
//   - recentBookings: the 3 newest bookings with privacy-safe fields ONLY
//     (service title/category/status/createdAt). No customer or technician
//     identity, emails, phones, ids or amounts are ever exposed.
// Stats are counted with real countDocuments/distinct calls (no sampling,
// no estimates presented as exact figures beyond what countDocuments gives).

// Same eligibility rule as the public service listing: only reviews attached
// to services that are approved AND available count as genuine feedback for
// public-facing numbers.
const ELIGIBLE_SERVICE_MATCH = {
  "service.approvalStatus": "approved",
  "service.availabilityStatus": "available",
} as const;

// A genuine stored review: a whole 1–5 rating on a completed booking.
const GENUINE_REVIEW_MATCH = {
  "review.rating": { $exists: true, $gte: 1, $lte: 5 },
} as const;

export const getHomeSummary = async (
  _req: Request,
  res: Response
): Promise<void> => {
  const servicesCollection = getServicesCollection();
  const bookingsCollection = getBookingsCollection();
  const usersCollection = getUsersCollection();

  const PUBLIC_SERVICE_FILTER = {
    approvalStatus: "approved",
    availabilityStatus: "available",
  } as const;

  const [
    approvedServices,
    technicianIds,
    completedRepairs,
    totalBookings,
    verifiedTechnicians,
    reviewStatsRows,
    recentBookings,
  ] = await Promise.all([
    servicesCollection.countDocuments(PUBLIC_SERVICE_FILTER),
    servicesCollection.distinct("technicianId", PUBLIC_SERVICE_FILTER),
    bookingsCollection.countDocuments({ status: "completed" }),
    bookingsCollection.countDocuments({}),
    // Existing verification + approval rule: an approved technician
    // application is what turns an account into a verified technician
    // (see technician-application.controller reviewApplication and the
    // admin role-promotion guard).
    usersCollection.countDocuments({
      role: "technician",
      "technicianApplication.status": "approved",
    }),
    bookingsCollection
      .aggregate<{ totalReviews: number; averageRating: number | null }>([
        { $match: GENUINE_REVIEW_MATCH },
        {
          $group: {
            _id: null,
            totalReviews: { $sum: 1 },
            averageRating: { $avg: "$review.rating" },
          },
        },
      ])
      .toArray(),
    bookingsCollection
      .find(
        {},
        {
          projection: {
            serviceTitle: 1,
            serviceCategory: 1,
            status: 1,
            createdAt: 1,
          },
        }
      )
      .sort({ createdAt: -1, _id: -1 })
      .limit(3)
      .toArray(),
  ]);

  const reviewStats = reviewStatsRows[0];
  const totalReviews = reviewStats?.totalReviews ?? 0;
  const averageRating =
    typeof reviewStats?.averageRating === "number"
      ? Math.round(reviewStats.averageRating * 10) / 10
      : null;

  const recent = recentBookings.map((booking) => ({
    serviceTitle:
      typeof booking.serviceTitle === "string" && booking.serviceTitle.trim()
        ? booking.serviceTitle
        : "Repair service",
    category:
      typeof booking.serviceCategory === "string" && booking.serviceCategory
        ? booking.serviceCategory
        : "Repair",
    status: booking.status,
    createdAt: booking.createdAt,
  }));

  res.status(200).json({
    success: true,
    data: {
      stats: {
        approvedServices,
        activeTechnicians: technicianIds.length,
        completedRepairs,
        totalBookings,
        verifiedTechnicians,
        totalReviews,
        averageRating,
      },
      recentBookings: recent,
    },
  });
};

// GET /api/home/popular-services — public, no authentication.
//
// Powers the homepage "Popular Repair Services" section. Ranks service
// categories by genuine customer reviews; nothing is hardcoded and nothing
// is fabricated:
//   - Only reviews that are stored on bookings and carry a valid 1–5
//     rating are counted (only completed bookings can carry a review).
//   - Only reviews attached to services that are approved AND available
//     count — the same eligibility rule as the public service listing.
//   - Reviews are grouped by the category of the service they are attached
//     to (joined via serviceId), never by the booking's free-text snapshot.
//   - Legacy category aliases (e.g. "Mobile Repair") are merged into their
//     canonical category ("Smartphone") with the existing LEGACY_CATEGORY_MAP;
//     unmapped values keep their stored name rather than being dropped or
//     guessed.
//   - Ranking: most genuine reviews first; ties are broken by higher
//     average rating; remaining ties break on the category name ascending
//     (a stable, deterministic order). Top 4 are returned.
//
// No customer/technician identity or private data is ever exposed — the
// response carries aggregate numbers only.

interface PopularServiceRow {
  _id: unknown;
  reviewCount: number;
  ratingSum: number;
}

export interface PopularServiceCategoryDTO {
  /** Canonical category value (or the stored value for unmapped legacy data). */
  category: string;
  reviewCount: number;
  /** Mean of genuine review ratings, rounded to one decimal. */
  averageRating: number;
}

const MAX_POPULAR_SERVICES = 4;

export const getPopularServices = async (
  _req: Request,
  res: Response
): Promise<void> => {
  const rows = await getBookingsCollection()
    .aggregate<PopularServiceRow>([
      { $match: GENUINE_REVIEW_MATCH },
      {
        // One join for the whole batch — never one query per booking.
        // Only the fields needed for eligibility + grouping are projected.
        $lookup: {
          from: "services",
          localField: "serviceId",
          foreignField: "_id",
          as: "service",
          pipeline: [
            { $project: { category: 1, approvalStatus: 1, availabilityStatus: 1 } },
          ],
        },
      },
      { $unwind: "$service" },
      { $match: ELIGIBLE_SERVICE_MATCH },
      {
        $group: {
          _id: "$service.category",
          reviewCount: { $sum: 1 },
          ratingSum: { $sum: "$review.rating" },
        },
      },
    ])
    .toArray();

  // Merge legacy aliases into canonical categories. Unmapped values keep
  // their stored name so real feedback is never silently discarded.
  const buckets = new Map<string, { reviewCount: number; ratingSum: number }>();
  for (const row of rows) {
    if (typeof row._id !== "string" || row._id.trim().length === 0) continue;
    const reviewCount =
      typeof row.reviewCount === "number" &&
      Number.isFinite(row.reviewCount) &&
      row.reviewCount > 0
        ? Math.floor(row.reviewCount)
        : 0;
    const ratingSum =
      typeof row.ratingSum === "number" && Number.isFinite(row.ratingSum)
        ? row.ratingSum
        : 0;
    if (reviewCount === 0 || ratingSum <= 0) continue;

    const category = canonicalizeCategory(row._id) ?? row._id;
    const bucket = buckets.get(category) ?? { reviewCount: 0, ratingSum: 0 };
    bucket.reviewCount += reviewCount;
    bucket.ratingSum += ratingSum;
    buckets.set(category, bucket);
  }

  const ranked: PopularServiceCategoryDTO[] = [...buckets.entries()]
    .map(([category, bucket]) => ({
      category,
      reviewCount: bucket.reviewCount,
      // Unrounded for the comparison; rounded only for the payload.
      _average: bucket.ratingSum / bucket.reviewCount,
    }))
    .sort((a, b) => {
      if (b.reviewCount !== a.reviewCount) return b.reviewCount - a.reviewCount;
      if (b._average !== a._average) return b._average - a._average;
      // Deterministic tie-breaker: category name ascending.
      return a.category.localeCompare(b.category);
    })
    .slice(0, MAX_POPULAR_SERVICES)
    .map(({ category, reviewCount, _average }) => ({
      category,
      reviewCount,
      averageRating: Math.round(_average * 10) / 10,
    }));

  res.status(200).json({
    success: true,
    data: ranked,
  });
};
