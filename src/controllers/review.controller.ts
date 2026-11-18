
import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
import { getBookingsCollection } from "../models/booking.model.js";
import {
  getUsersCollection,
} from "../models/technician-application.model.js";
import { latestReviewsQuerySchema } from "../validators/review.validator.js";

// Public-safe projection of a booking's review. Contains nothing private:
// no customer id/email/phone, no internal document fields beyond what the
// public homepage needs. The booking snapshot fields (customerName,
// technicianName, serviceTitle) are display names captured at booking time
// from server-side records — never from a request body.
interface LatestReviewRow {
  _id: ObjectId;
  customerId: ObjectId;
  customerName?: unknown;
  technicianName?: unknown;
  serviceTitle?: unknown;
  serviceCategory?: unknown;
  review?: {
    rating?: unknown;
    comment?: unknown;
    createdAt?: unknown;
  };
}

interface PublicReviewDTO {
  customer: {
    /** Display name, or a privacy-safe fallback when the snapshot is blank. */
    name: string;
    /** Profile image only when the account publicly exposes one; else null. */
    image: string | null;
  };
  rating: number;
  comment: string;
  createdAt: Date;
  service: {
    title: string;
    category: string;
  };
  technician: {
    name: string;
  };
}

const displayName = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

// GET /api/reviews — public, no authentication.
// Returns the latest real customer reviews (at most 6), newest first. Every
// field is computed from stored bookings; nothing is fabricated. Customer
// images come from a single batched lookup against the Better Auth user
// collection projecting ONLY the public `image` field.
export const getLatestReviews = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parsed = latestReviewsQuerySchema.safeParse(req.query);

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

  const limit = parsed.data.limit ?? 6;
  const page = parsed.data.page ?? 1;
  const skip = (page - 1) * limit;

  const REVIEW_EXISTS = { review: { $exists: true } } as const;

  const [rows, totalItems] = await Promise.all([
    getBookingsCollection()
      .aggregate<LatestReviewRow>([
        { $match: REVIEW_EXISTS },
        { $sort: { "review.createdAt": -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            _id: 1,
            customerId: 1,
            customerName: 1,
            technicianName: 1,
            serviceTitle: 1,
            serviceCategory: 1,
            review: 1,
          },
        },
      ])
      .toArray(),
    getBookingsCollection().countDocuments(REVIEW_EXISTS),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

  // One batched lookup for customer profile images — never one query per
  // review. Only `image` is projected; no other account data leaves the
  // users collection.
  const customerIds = [
    ...new Map(rows.map((row) => [row.customerId.toHexString(), row.customerId])).values(),
  ];
  const imageByCustomer = new Map<string, string | null>();
  if (customerIds.length > 0) {
    const users = await getUsersCollection()
      .find({ _id: { $in: customerIds } }, { projection: { image: 1 } })
      .toArray();
    for (const user of users) {
      const image: unknown = user.image;
      imageByCustomer.set(
        user._id.toHexString(),
        typeof image === "string" && image.trim().length > 0 ? image : null
      );
    }
  }

  const data: PublicReviewDTO[] = [];
  for (const row of rows) {
    const review = row.review;
    const rating = review?.rating;
    const comment = review?.comment;
    const createdAt = review?.createdAt;

    // Defensive: a stored review must carry the full validated shape. Any
    // row that does not is skipped rather than leaked or fabricated.
    if (
      typeof rating !== "number" ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5 ||
      typeof comment !== "string" ||
      comment.trim().length === 0 ||
      !(createdAt instanceof Date)
    ) {
      continue;
    }

    data.push({
      customer: {
        name: displayName(row.customerName, "FixMate Customer"),
        image: imageByCustomer.get(row.customerId.toHexString()) ?? null,
      },
      rating,
      comment,
      createdAt,
      service: {
        title: displayName(row.serviceTitle, "Repair service"),
        category: displayName(row.serviceCategory, "Repair"),
      },
      technician: {
        name: displayName(row.technicianName, "FixMate Technician"),
      },
    });
  }

  res.status(200).json({
    success: true,
    data,
    pagination: {
      currentPage: page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  });
};
