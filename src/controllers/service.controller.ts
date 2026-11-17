
import type { Response } from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { createServiceSchema, updateServiceSchema } from "../validators/service.validator.js";
import {
  getServicesCollection,
  type Service,
  type ServiceApprovalStatus,
} from "../models/service.model.js";

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

// Only fields a client may edit. approvalStatus/updatedAt are added by the
// server, everything else on the document is preserved.
type ClientEditableFields = Pick<
  Service,
  | "title"
  | "category"
  | "description"
  | "overview"
  | "hourlyRate"
  | "securityDeposit"
  | "maxCapacity"
  | "location"
  | "image"
  | "amenities"
>;

interface ServiceUpdateSet
  extends Partial<ClientEditableFields> {
  approvalStatus: ServiceApprovalStatus;
  updatedAt: Date;
}

// Fields shared by the update path: technician identity comes exclusively
// from the verified JWT, never from params/body.
const resolveTechnicianId = (
  req: AuthenticatedRequest
): ObjectId | null => {
  if (!req.user || !ObjectId.isValid(req.user.id)) {
    return null;
  }
  return new ObjectId(req.user.id);
};

// Express 5 types route params as string | string[]; normalize and validate.
const parseServiceId = (raw: unknown): ObjectId | null => {
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    return null;
  }

  return new ObjectId(id);
};

// PATCH /api/services/:id — technician only (verifyToken -> verifyTechnician).
// Ownership is enforced by the {_id, technicianId} filter, so one technician
// can never edit another's service (404 either way, indistinguishable).
export const updateService = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const technicianId = resolveTechnicianId(req);

  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  if (!technicianId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const { id } = req.params;
  const serviceId = parseServiceId(id);

  if (!serviceId) {
    res.status(400).json({
      success: false,
      message: "Invalid service id.",
    });
    return;
  }

  const parsed = updateServiceSchema.safeParse(req.body);

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

  // $set contains only validated, client-editable fields plus the
  // server-controlled re-approval/updatedAt values.
  const update: ServiceUpdateSet = {
    ...parsed.data,
    approvalStatus: "pending",
    updatedAt: new Date(),
  };

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const updated = await getServicesCollection().findOneAndUpdate(
    { _id: serviceId, technicianId },
    { $set: update },
    { returnDocument: "after" }
  );

  if (!updated) {
    res.status(404).json({
      success: false,
      message: "Service not found.",
    });
    return;
  }

  res.status(200).json({
    success: true,
    message: "Service updated successfully.",
    data: updated,
  });
};

// DELETE /api/services/:id — technician only (verifyToken -> verifyTechnician).
export const deleteService = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const technicianId = resolveTechnicianId(req);

  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  if (!technicianId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const { id } = req.params;
  const serviceId = parseServiceId(id);

  if (!serviceId) {
    res.status(400).json({
      success: false,
      message: "Invalid service id.",
    });
    return;
  }

  // Ownership enforced by the same {_id, technicianId} filter.
  const result = await getServicesCollection().deleteOne({
    _id: serviceId,
    technicianId,
  });

  if (result.deletedCount === 0) {
    res.status(404).json({
      success: false,
      message: "Service not found.",
    });
    return;
  }

  res.status(200).json({
    success: true,
    message: "Service deleted successfully.",
  });
};

