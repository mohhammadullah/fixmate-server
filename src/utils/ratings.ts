
import { ObjectId } from "mongodb";
import { getBookingsCollection } from "../models/booking.model.js";

export interface ServiceRatingSummary {
  /** Mean of all review ratings, rounded to one decimal; null when unrated. */
  averageRating: number | null;
  reviewCount: number;
}

interface RatingAggregateRow {
  _id: ObjectId;
  averageRating: number;
  reviewCount: number;
}

/**
 * Aggregates the actual ratings stored as booking review subdocuments for a
 * set of services. One aggregation for the whole batch (never one query per
 * service); the partial index `bookings_serviceId_1_review` bounds the scan
 * to bookings that carry a review.
 */
export const fetchServiceRatings = async (
  serviceIds: ObjectId[]
): Promise<Map<string, ServiceRatingSummary>> => {
  const summaries = new Map<string, ServiceRatingSummary>();
  if (serviceIds.length === 0) return summaries;

  const rows = await getBookingsCollection()
    .aggregate<RatingAggregateRow>([
      {
        $match: {
          serviceId: { $in: serviceIds },
          "review.rating": { $exists: true },
        },
      },
      {
        $group: {
          _id: "$serviceId",
          averageRating: { $avg: "$review.rating" },
          reviewCount: { $sum: 1 },
        },
      },
    ])
    .toArray();

  for (const row of rows) {
    summaries.set(row._id.toHexString(), {
      averageRating: Math.round(row.averageRating * 10) / 10,
      reviewCount: row.reviewCount,
    });
  }

  return summaries;
};

/** Rating summary for a single service. */
export const fetchServiceRating = async (
  serviceId: ObjectId
): Promise<ServiceRatingSummary> => {
  const summaries = await fetchServiceRatings([serviceId]);
  return summaries.get(serviceId.toHexString()) ?? {
    averageRating: null,
    reviewCount: 0,
  };
};

export const UNRATED_RATING: ServiceRatingSummary = {
  averageRating: null,
  reviewCount: 0,
};
