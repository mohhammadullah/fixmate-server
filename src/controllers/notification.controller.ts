
import type { Response } from "express";
import { ObjectId, type Document } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import {
  getUsersCollection,
} from "../models/technician-application.model.js";
import {
  notificationsQuerySchema,
  notificationIdParamSchema,
} from "../validators/features.validator.js";
import {
  toPublicNotificationDto,
} from "../utils/notifications.js";
import type { AppNotification } from "../models/user-config.model.js";
import { MAX_NOTIFICATIONS } from "../models/user-config.model.js";

// Notification APIs — read/update embedded notifications on the caller's
// own user document. No cross-user access exists anywhere in this file.

const readOwnNotifications = async (userId: ObjectId): Promise<AppNotification[]> => {
  const doc = await getUsersCollection().findOne(
    { _id: userId },
    { projection: { notifications: 1 } }
  );
  const list = (doc?.notifications ?? []) as AppNotification[];
  // Newest first for display.
  return [...list].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
};

export const getMyNotifications = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;
  if (!authUser || !ObjectId.isValid(authUser.id)) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const parsed = notificationsQuerySchema.safeParse(req.query);
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

  const page = parsed.data.page ?? 1;
  const limit = Math.min(parsed.data.limit ?? 20, MAX_NOTIFICATIONS);
  const unreadOnly = parsed.data.unreadOnly === "true";

  const all = await readOwnNotifications(new ObjectId(authUser.id));
  const filtered = unreadOnly ? all.filter((n) => !n.readAt) : all;

  const totalItems = filtered.length;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  const start = (page - 1) * limit;
  const slice = filtered.slice(start, start + limit);

  res.status(200).json({
    success: true,
    data: slice.map(toPublicNotificationDto),
    unreadCount: all.filter((n) => !n.readAt).length,
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

export const getUnreadCount = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;
  if (!authUser || !ObjectId.isValid(authUser.id)) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const all = await readOwnNotifications(new ObjectId(authUser.id));
  res.status(200).json({
    success: true,
    data: { unreadCount: all.filter((n) => !n.readAt).length },
  });
};

export const markNotificationRead = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;
  if (!authUser || !ObjectId.isValid(authUser.id)) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsedId = notificationIdParamSchema.safeParse(rawId);
  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid notification id." });
    return;
  }

  const now = new Date();
  // Only the owner's embedded array is touched; the filter pins both the
  // user id and the notification id.
  const update: Document = {
    $set: { "notifications.$[n].readAt": now },
  };
  const result = await getUsersCollection().updateOne(
    { _id: new ObjectId(authUser.id), "notifications.id": parsedId.data },
    update,
    { arrayFilters: [{ "n.id": parsedId.data, "n.readAt": null }] }
  );

  if (result.matchedCount === 0 && result.modifiedCount === 0) {
    // Either the notification doesn't exist, belongs to someone else, or is
    // already read — all indistinguishable; treat as found-or-already-read.
    const all = await readOwnNotifications(new ObjectId(authUser.id));
    const exists = all.find((n) => n.id === parsedId.data);
    if (!exists) {
      res.status(404).json({ success: false, message: "Notification not found." });
      return;
    }
  }

  res.status(200).json({ success: true, message: "Notification marked as read." });
};

export const markAllNotificationsRead = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;
  if (!authUser || !ObjectId.isValid(authUser.id)) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const now = new Date();
  const update: Document = { $set: { "notifications.$[].readAt": now } };
  await getUsersCollection().updateOne(
    { _id: new ObjectId(authUser.id) },
    update
  );

  res.status(200).json({ success: true, message: "All notifications marked as read." });
};
