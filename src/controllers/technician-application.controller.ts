import type { Response } from "express";
import { ObjectId } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import {
  getUsersCollection,
  type TechnicianApplication,
  type UserWithApplication,
} from "../models/technician-application.model.js";
import {
  submitApplicationSchema,
  applicationQuerySchema,
  reviewApplicationSchema,
} from "../validators/technician-application.validator.js";

const OBJECT_ID_HEX_REGEX = /^[0-9a-fA-F]{24}$/;

const parseUserId = (raw: unknown): ObjectId | null => {
  if (typeof raw !== "string" || !OBJECT_ID_HEX_REGEX.test(raw)) return null;
  return new ObjectId(raw);
};

const validationIssues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));

const safeId = (value: ObjectId | undefined): string | null =>
  value ? value.toHexString() : null;

/** Safe application view for the owning user. Profile fields are read from
 *  the existing user profile; application-only fields come from the subdoc. */
const toOwnerDto = (user: UserWithApplication) => {
  const app: TechnicianApplication | undefined = user.technicianApplication;
  return {
    status: app?.status ?? "none",
    phone: user.phone ?? null,
    area: user.area ?? null,
    bio: user.bio ?? null,
    experience: app?.experience ?? null,
    skills: app?.skills ?? [],
    submittedAt: app?.submittedAt ?? null,
    reviewedAt: app?.reviewedAt ?? null,
    reviewedBy: safeId(app?.reviewedBy),
    // Rejection reasons are safe for the applicant to see.
    rejectionReason: app?.rejectionReason ?? null,
  };
};

/** Safe applicant view for admins. Never exposes password hashes, provider
 *  accounts, sessions, or internal Better Auth fields. */
const toAdminDto = (user: UserWithApplication) => {
  const app = user.technicianApplication as TechnicianApplication;
  return {
    userId: user._id.toHexString(),
    name: user.name ?? null,
    email: user.email ?? null,
    phone: user.phone ?? null,
    area: user.area ?? null,
    bio: user.bio ?? null,
    status: app.status,
    experience: app.experience,
    skills: app.skills,
    submittedAt: app.submittedAt,
    reviewedAt: app.reviewedAt ?? null,
    reviewedBy: safeId(app.reviewedBy),
    rejectionReason: app.rejectionReason ?? null,
  };
};

// POST /api/technician-applications — customer only.
// Profile fields (phone/area/bio) are written to the existing user profile;
// application-only fields live in the `technicianApplication` subdocument.
// The atomic filter rejects a second pending application.
export const submitApplication = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  const userId = parseUserId(req.user.id);
  if (!userId) {
    res.status(401).json({ success: false, message: "Invalid token payload." });
    return;
  }

  const parsed = submitApplicationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: validationIssues(parsed.error),
    });
    return;
  }

  const { phone, area, experience, skills, bio } = parsed.data;
  const updated = await getUsersCollection().findOneAndUpdate(
    {
      _id: userId,
      $or: [
        { "technicianApplication.status": { $exists: false } },
        { "technicianApplication.status": { $ne: "pending" } },
      ],
    },
    {
      $set: {
        // Reuse existing profile fields instead of duplicating them.
        phone,
        area,
        bio,
        technicianApplication: {
          status: "pending",
          experience,
          skills,
          submittedAt: new Date(),
        },
      },
    },
    { returnDocument: "after" }
  );

  if (updated) {
    res.status(200).json({
      success: true,
      message: "Application submitted successfully.",
      data: toOwnerDto(updated),
    });
    return;
  }

  // A failed update is either a duplicate pending application, a missing
  // user, or an account that can no longer apply.
  const user = await getUsersCollection().findOne({ _id: userId });
  if (!user) {
    res.status(404).json({ success: false, message: "Account not found." });
    return;
  }
  if (user.role === "technician" || user.role === "admin") {
    res.status(403).json({
      success: false,
      message: "This account is not a customer and cannot apply.",
    });
    return;
  }
  res.status(409).json({
    success: false,
    message: "An application is already pending review.",
  });
};

// GET /api/technician-applications/my — any authenticated user sees only
// their own application (or null when none has been submitted).
export const getMyApplication = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  const userId = parseUserId(req.user.id);
  if (!userId) {
    res.status(401).json({ success: false, message: "Invalid token payload." });
    return;
  }
  const user = await getUsersCollection().findOne(
    { _id: userId },
    {
      projection: {
        phone: 1,
        area: 1,
        bio: 1,
        technicianApplication: 1,
      },
    }
  );
  if (!user) {
    res.status(404).json({ success: false, message: "Account not found." });
    return;
  }
  res.status(200).json({
    success: true,
    data: user.technicianApplication ? toOwnerDto(user) : null,
  });
};

// GET /api/technician-applications — admin only, paginated, newest first.
export const listApplications = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const parsed = applicationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: validationIssues(parsed.error),
    });
    return;
  }

  const { status } = parsed.data;
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 12;
  const filter = {
    "technicianApplication.status": status ?? { $exists: true },
  };

  const [items, totalItems] = await Promise.all([
    getUsersCollection()
      .find(filter, {
        projection: {
          name: 1,
          email: 1,
          phone: 1,
          area: 1,
          bio: 1,
          technicianApplication: 1,
        },
      })
      .sort({ "technicianApplication.submittedAt": -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getUsersCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  res.status(200).json({
    success: true,
    data: items.filter((item) => item.technicianApplication).map(toAdminDto),
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

// PATCH /api/technician-applications/:userId/review — admin only.
// Reviewer identity always comes from the verified JWT, never the body.
// Approve atomically sets both the applicant role and application status.
export const reviewApplication = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  const applicantId = parseUserId(req.params.userId);
  if (!applicantId) {
    res.status(400).json({ success: false, message: "Invalid applicant id." });
    return;
  }
  const adminId = parseUserId(req.user.id);
  if (!adminId) {
    res.status(401).json({ success: false, message: "Invalid token payload." });
    return;
  }

  const parsed = reviewApplicationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: validationIssues(parsed.error),
    });
    return;
  }
  const { decision, rejectionReason } = parsed.data;
  const reviewedAt = new Date();

  const update =
    decision === "approve"
      ? {
          $set: {
            role: "technician",
            "technicianApplication.status": "approved",
            "technicianApplication.reviewedAt": reviewedAt,
            "technicianApplication.reviewedBy": adminId,
          },
          $unset: { "technicianApplication.rejectionReason": "" as const },
        }
      : {
          $set: {
            "technicianApplication.status": "rejected",
            "technicianApplication.reviewedAt": reviewedAt,
            "technicianApplication.reviewedBy": adminId,
            "technicianApplication.rejectionReason": rejectionReason,
          },
        };

  const updated = await getUsersCollection().findOneAndUpdate(
    { _id: applicantId, "technicianApplication.status": "pending" },
    update,
    { returnDocument: "after" }
  );

  if (updated) {
    res.status(200).json({
      success: true,
      message:
        decision === "approve"
          ? "Application approved. The applicant is now a technician."
          : "Application rejected.",
      data: {
        userId: updated._id.toHexString(),
        status: updated.technicianApplication?.status,
        role: updated.role,
        reviewedAt: updated.technicianApplication?.reviewedAt ?? null,
        reviewedBy: safeId(updated.technicianApplication?.reviewedBy),
        rejectionReason: updated.technicianApplication?.rejectionReason ?? null,
      },
    });
    return;
  }

  const existing = await getUsersCollection().findOne(
    { _id: applicantId },
    { projection: { "technicianApplication.status": 1 } }
  );
  if (!existing || !existing.technicianApplication) {
    res.status(404).json({ success: false, message: "Application not found." });
    return;
  }
  res.status(409).json({
    success: false,
    message: "This application has already been reviewed or is no longer pending.",
  });
};
