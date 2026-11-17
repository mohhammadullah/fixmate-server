
import type { Request, Response } from "express";
import { ObjectId, type Filter, type Sort } from "mongodb";
import { getDB } from "../config/db.js";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { createServiceSchema, updateServiceSchema, rejectServiceSchema, listServicesQuerySchema, listMyServicesQuerySchema, escapeRegExp, type ListServicesSort } from "../validators/service.validator.js";
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

// Admin moderation endpoints require a strict 24-character hex ObjectId:
// ObjectId.isValid would also accept 12-byte strings, so check explicitly.
const OBJECT_ID_HEX_REGEX = /^[0-9a-fA-F]{24}$/;

const parseAdminServiceId = (raw: unknown): ObjectId | null => {
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (typeof id !== "string" || !OBJECT_ID_HEX_REGEX.test(id)) {
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

// Admin moderation endpoints (verifyToken -> verifyAdmin).
//
// Race-condition safety: the pending-only transition is enforced by the
// atomic {_id, approvalStatus: "pending"} filter passed to findOneAndUpdate,
// never by a prior read. Two concurrent admin decisions therefore cannot
// both win — the loser matches nothing and is reported as 409 (or 404 if
// the document vanished in between). The second lookup below runs only
// after a failed atomic update and exists purely to distinguish those two
// cases; it never authorizes a write.

const respondAfterFailedTransition = async (
  res: Response,
  serviceId: ObjectId
): Promise<void> => {
  const existing = await getServicesCollection().findOne(
    { _id: serviceId },
    { projection: { _id: 1 } }
  );

  if (!existing) {
    res.status(404).json({
      success: false,
      message: "Service not found.",
    });
    return;
  }

  res.status(409).json({
    success: false,
    message: "Service has already been approved or rejected.",
  });
};

// GET /api/services — public, no authentication.
//
// Only approved + available services are returned. Internal-only fields
// (rejectionReason, technicianEmail, technicianId) are stripped by the
// projection; everything else is a public service field. All query input is
// validated by listServicesQuerySchema, regex input is escaped, and the
// filter is a typed MongoDB Filter built exclusively from validated values —
// raw query parameters can never reach the query engine.

// Documents returned by the public listing: everything on Service except the
// internal-only fields removed by the projection below.
type PublicService = Omit<
  Service,
  "technicianId" | "technicianEmail" | "rejectionReason"
>;

const PUBLIC_PROJECTION = {
  rejectionReason: 0,
  technicianEmail: 0,
  technicianId: 0,
} as const;

const resolvePublicSort = (sort: ListServicesSort): Sort => {
  switch (sort) {
    case "price_asc":
      // _id tie-breaker keeps pagination deterministic.
      return { hourlyRate: 1, _id: 1 };
    case "price_desc":
      return { hourlyRate: -1, _id: -1 };
    case "newest":
      return { createdAt: -1, _id: -1 };
  }
};

// Safe DTO for the technician "my services" dashboard. Contains only what
// the dashboard needs; internal MongoDB fields (_id, technicianId,
// availabilityStatus), account data (technicianName/technicianEmail), the
// raw description and admin-only fields (rejectionReason) are deliberately
// excluded. `isAvailable` mirrors availabilityStatus.
interface MyServiceDTO {
  id: string;
  title: string;
  category: Service["category"];
  location: string;
  image: string;
  hourlyRate: number;
  securityDeposit: number;
  maxCapacity: number;
  amenities: string[];
  overview: string;
  approvalStatus: ServiceApprovalStatus;
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const toMyServiceDTO = (service: Service): MyServiceDTO => ({
  id: service._id.toHexString(),
  title: service.title,
  category: service.category,
  location: service.location,
  image: service.image,
  hourlyRate: service.hourlyRate,
  securityDeposit: service.securityDeposit,
  maxCapacity: service.maxCapacity,
  amenities: service.amenities,
  overview: service.overview,
  approvalStatus: service.approvalStatus,
  isAvailable: service.availabilityStatus === "available",
  createdAt: service.createdAt,
  updatedAt: service.updatedAt,
});

export const listServices = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parsed = listServicesQuerySchema.safeParse(req.query);

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

  const { search, category, location, minPrice, maxPrice, sort } = parsed.data;
  const page = parsed.data.page ?? 1;
  // Chosen behavior: limit above 50 is rejected by the schema with 400.
  const limit = parsed.data.limit ?? 12;

  const filter: Filter<Service> = {
    approvalStatus: "approved",
    availabilityStatus: "available",
  };

  if (search) {
    const pattern = { $regex: escapeRegExp(search), $options: "i" as const };
    filter.$or = [
      { title: pattern },
      { description: pattern },
      { overview: pattern },
      { location: pattern },
      { category: pattern },
    ];
  }

  if (category) {
    filter.category = category;
  }

  if (location) {
    filter.location = { $regex: escapeRegExp(location), $options: "i" };
  }

  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.hourlyRate = {
      ...(minPrice !== undefined ? { $gte: minPrice } : {}),
      ...(maxPrice !== undefined ? { $lte: maxPrice } : {}),
    };
  }

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware (no internals exposed).
  const [items, totalItems] = await Promise.all([
    getServicesCollection()
      .find(filter, { projection: PUBLIC_PROJECTION })
      .sort(resolvePublicSort(sort))
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray() as Promise<PublicService[]>,
    getServicesCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

  res.status(200).json({
    success: true,
    data: items,
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

// PATCH /api/services/:id/approve — admin only (verifyToken -> verifyAdmin).
// Approval identity is never taken from the request; the token only
// authorizes the caller. All other document fields are preserved.
export const approveService = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  const { id } = req.params;
  const serviceId = parseAdminServiceId(id);

  if (!serviceId) {
    res.status(400).json({
      success: false,
      message: "Invalid service id.",
    });
    return;
  }

  const now = new Date();

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const updated = await getServicesCollection().findOneAndUpdate(
    { _id: serviceId, approvalStatus: "pending" },
    {
      $set: { approvalStatus: "approved", updatedAt: now },
      $unset: { rejectionReason: "" },
    },
    { returnDocument: "after" }
  );

  if (!updated) {
    await respondAfterFailedTransition(res, serviceId);
    return;
  }

  res.status(200).json({
    success: true,
    message: "Service approved successfully.",
    data: updated,
  });
};

// PATCH /api/services/:id/reject — admin only (verifyToken -> verifyAdmin).
// The only client-supplied value is rejectionReason, validated and trimmed
// by rejectServiceSchema; everything server-controlled is rejected by the
// strict object shape. All other document fields are preserved.
export const rejectService = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  const { id } = req.params;
  const serviceId = parseAdminServiceId(id);

  if (!serviceId) {
    res.status(400).json({
      success: false,
      message: "Invalid service id.",
    });
    return;
  }

  const parsed = rejectServiceSchema.safeParse(req.body);

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

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const updated = await getServicesCollection().findOneAndUpdate(
    { _id: serviceId, approvalStatus: "pending" },
    {
      $set: {
        approvalStatus: "rejected",
        rejectionReason: parsed.data.rejectionReason,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (!updated) {
    await respondAfterFailedTransition(res, serviceId);
    return;
  }

  res.status(200).json({
    success: true,
    message: "Service rejected successfully.",
    data: updated,
  });
};

const MY_SERVICES_SORT: Sort = { createdAt: -1, _id: -1 };

// GET /api/services/my — technician only (verifyToken -> verifyTechnician).
// Returns only services whose technicianId matches the verified JWT; any
// technicianId in the query string is stripped by the schema and ignored.
// Sorted newest first; pagination metadata matches the booking list
// endpoints. Unlike the public listing this returns every approval status
// (pending/approved/rejected) unless `approvalStatus`/`isAvailable` narrow
// the result set.
export const listMyServices = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
    return;
  }

  const technicianId = resolveTechnicianId(req);

  if (!technicianId) {
    res.status(401).json({
      success: false,
      message: "Invalid token payload.",
    });
    return;
  }

  const parsed = listMyServicesQuerySchema.safeParse(req.query);

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

  const { approvalStatus, isAvailable } = parsed.data;
  const page = parsed.data.page ?? 1;
  // Chosen behavior (consistent with the booking list endpoints): limit
  // defaults to 10 here and a limit above 50 is rejected with HTTP 400.
  const limit = parsed.data.limit ?? 10;

  const filter: Filter<Service> = { technicianId };

  if (approvalStatus) {
    filter.approvalStatus = approvalStatus;
  }

  if (isAvailable !== undefined) {
    filter.availabilityStatus = isAvailable ? "available" : "unavailable";
  }

  // MongoDB errors propagate to Express 5, which forwards them to the
  // existing errorHandler middleware.
  const [items, totalItems] = await Promise.all([
    getServicesCollection()
      .find(filter)
      .sort(MY_SERVICES_SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    getServicesCollection().countDocuments(filter),
  ]);

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

  res.status(200).json({
    success: true,
    data: items.map(toMyServiceDTO),
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

