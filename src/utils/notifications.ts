
import { ObjectId, type Document } from "mongodb";
import {
  getUsersCollection,
  USERS_COLLECTION,
} from "../models/technician-application.model.js";
import {
  MAX_NOTIFICATIONS,
  type AppNotification,
  type NotificationType,
} from "../models/user-config.model.js";
import { emitToUser } from "../socket.js";
import { getDB } from "../config/db.js";

// Server-generated notification. Persisted embedded on each recipient's
// user document (bounded at MAX_NOTIFICATIONS via $slice) AND delivered in
// real time over Socket.IO when the recipient is connected.

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  bookingId?: ObjectId;
  serviceId?: ObjectId;
}

const sanitize = (value: string, max: number): string => {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

/** Build the public payload that travels over the socket. */
const toPublicNotification = (n: AppNotification) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  bookingId: n.bookingId ? n.bookingId.toHexString() : undefined,
  serviceId: n.serviceId ? n.serviceId.toHexString() : undefined,
  createdAt: n.createdAt.toISOString(),
  readAt: n.readAt ? n.readAt.toISOString() : null,
});

export const toPublicNotificationDto = toPublicNotification;

/**
 * Persist + deliver a notification to a set of users. Per-recipient $slice
 * keeps each user's embedded array bounded. Duplicate deliveries (retry /
 * webhook replay) result in a second notification record only when the
 * underlying event is re-emitted — callers are responsible for invoking
 * this only on real state transitions (see modifiedCount gating pattern).
 * The atomic $slice keeps documents consistent either way.
 */
export const notifyUsers = async (
  userIds: readonly ObjectId[],
  input: NotifyInput
): Promise<void> => {
  const unique = [...new Map(userIds.map((id) => [id.toHexString(), id])).values()];
  if (unique.length === 0) return;

  const now = new Date();
  const notification: AppNotification = {
    id: new ObjectId().toHexString(),
    type: input.type,
    title: sanitize(input.title, 120),
    body: sanitize(input.body, 300),
    bookingId: input.bookingId,
    serviceId: input.serviceId,
    createdAt: now,
    readAt: null,
  };

  await Promise.allSettled(
    unique.map(async (userId) => {
      try {
        const update: Document = {
          $push: {
            notifications: {
              $each: [notification],
              $slice: -MAX_NOTIFICATIONS,
            },
          },
        };
        await getUsersCollection().updateOne({ _id: userId }, update);
      } catch (error) {
        // Notifications must never break the main operation.
        console.error("Failed to persist notification for user", userId.toHexString(), error);
        return;
      }
      emitToUser(userId, "notification", toPublicNotification(notification));
    })
  );
};

/** All admins (role === "admin"), best-effort bounded. */
export const adminUserIds = async (): Promise<ObjectId[]> => {
  const admins = await getDB()
    .collection(USERS_COLLECTION)
    .find({ role: "admin" }, { projection: { _id: 1 } })
    .limit(50)
    .toArray();
  return admins.map((a) => a._id as ObjectId);
};
