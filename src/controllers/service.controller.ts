
import type { Response } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { createServiceSchema } from "../validators/service.validator.js";
import { getServicesCollection, type Service } from "../models/service.model.js";

// Better Auth's MongoDB adapter stores users in the singular `user`
// collection with `_id` as an ObjectId; the JWT's `id` claim is the
// ObjectId hex string.
const USERS_COLLECTION = "user";

interface AuthUserDocument {
  _id: ObjectId;
  name?: unknown;
  email?: unknown;
  role?: unknown;
}

// POST /api/services — technician only (verifyToken -> verifyTechnician).
// Technician identity/role are taken exclusively from the verified JWT and
// the server-side user document; client-supplied identity/status fields
// are rejected by the strict validator.
export const createService = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;

  if (!authUser) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  if (!ObjectId.isValid(authUser.id)) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const parsed = createServiceSchema.safeParse(req.body);

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

  const technicianId = new ObjectId(authUser.id);

  // Name/email must come from server-side state, not the token or body.
  // The token is only used to find and authorize the account.
  const dbUser = await getDB()
    .collection<AuthUserDocument>(USERS_COLLECTION)
    .findOne({ _id: technicianId });

  if (!dbUser) {
    res.status(401).json({
      success: false,
      message: "Authenticated user account no longer exists.",
    });
    return;
  }

  const technicianName =
    typeof dbUser.name === "string" && dbUser.name.trim().length > 0
      ? dbUser.name.trim()
      : undefined;
  const technicianEmail =
    typeof dbUser.email === "string" && dbUser.email.trim().length > 0
      ? dbUser.email.trim()
      : undefined;

  if (!technicianName || !technicianEmail) {
    res.status(500).json({
      success: false,
      message: "Unable to load technician profile.",
    });
    return;
  }

  const now = new Date();

  const newService: Service = {
    _id: new ObjectId(),
    ...parsed.data,
    technicianId,
    technicianName,
    technicianEmail,
    approvalStatus: "pending",
    availabilityStatus: "available",
    createdAt: now,
    updatedAt: now,
  };

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  await getServicesCollection().insertOne(newService);

  res.status(201).json({
    success: true,
    message: "Service created successfully.",
    data: newService,
  });
};
