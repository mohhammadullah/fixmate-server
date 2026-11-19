
import type { Response } from "express";
import { ObjectId, type Document } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import { getBookingsCollection } from "../models/booking.model.js";
import {
  sendChatMessageSchema,
  chatQuerySchema,
  bookingIdParamSchema,
} from "../validators/features.validator.js";
import {
  CHAT_MESSAGES_CAP,
  CHAT_PAGE_SIZE,
  type ChatMessage,
} from "../models/booking-extras.model.js";
import { emitToBookingRoom, emitToUser } from "../socket.js";

// Booking-specific customer <-> technician chat. Admins may read (moderation)
// but never send. Identity comes exclusively from the verified JWT.

type ChatAccess = "owner-customer" | "assigned-technician" | "admin" | null;

const resolveAccess = async (
  bookingId: ObjectId,
  authUser: { id: string; role: string }
): Promise<{ access: ChatAccess; booking?: Awaited<ReturnType<typeof loadBooking>> }> => {
  const booking = await loadBooking(bookingId);
  if (!booking) return { access: null };

  const rawId = authUser.id;
  const isParticipantCustomer = booking.customerId.toHexString() === rawId;
  const isAssignedTechnician = booking.technicianId.toHexString() === rawId;

  if (isParticipantCustomer) return { access: "owner-customer", booking };
  if (isAssignedTechnician) return { access: "assigned-technician", booking };
  if (authUser.role === "admin") return { access: "admin", booking };
  return { access: null };
};

const loadBooking = (bookingId: ObjectId) =>
  getBookingsCollection().findOne(
    { _id: bookingId },
    {
      projection: {
        serviceTitle: 1,
        customerId: 1,
        technicianId: 1,
        "conversation.messages": 1,
      },
    }
  );

const publicMessage = (message: ChatMessage) => ({
  id: message.id,
  senderId: message.senderId.toHexString(),
  senderRole: message.senderRole,
  text: message.text,
  createdAt: message.createdAt instanceof Date
    ? message.createdAt.toISOString()
    : String(message.createdAt),
  readAt: message.readAt instanceof Date
    ? message.readAt.toISOString()
    : message.readAt === null
      ? null
      : undefined,
});

const parseBookingIdParam = (raw: unknown): ObjectId | null => {
  const id = Array.isArray(raw) ? raw[0] : raw;
  const parsed = bookingIdParamSchema.safeParse(id);
  return parsed.success ? new ObjectId(parsed.data) : null;
};

export const listChatMessages = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const bookingId = parseBookingIdParam(req.params.id);
  if (!bookingId) {
    res.status(400).json({ success: false, message: "Invalid booking id." });
    return;
  }

  const parsed = chatQuerySchema.safeParse(req.query);
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

  const { access, booking } = await resolveAccess(bookingId, req.user);
  if (!access || !booking) {
    res.status(404).json({ success: false, message: "Booking not found." });
    return;
  }

  const all = booking.conversation?.messages ?? [];
  const limit = parsed.data.limit ?? CHAT_PAGE_SIZE;
  const beforeId = parsed.data.before;

  let endExclusive = all.length;
  if (beforeId) {
    const beforeIndex = all.findIndex((message) => message.id === beforeId);
    endExclusive = beforeIndex >= 0 ? beforeIndex : all.length;
  }
  const start = Math.max(0, endExclusive - limit);
  const page = all.slice(start, endExclusive);

  const unreadCount = all.filter(
    (message) =>
      message.senderId.toHexString() !== req.user!.id && !message.readAt
  ).length;

  res.status(200).json({
    success: true,
    data: page.map(publicMessage),
    unreadCount,
    hasMore: start > 0,
  });
};

export const sendChatMessage = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const bookingId = parseBookingIdParam(req.params.id);
  if (!bookingId) {
    res.status(400).json({ success: false, message: "Invalid booking id." });
    return;
  }

  const parsed = sendChatMessageSchema.safeParse(req.body ?? {});
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

  const { access, booking } = await resolveAccess(bookingId, req.user);
  if (!access || !booking) {
    res.status(404).json({ success: false, message: "Booking not found." });
    return;
  }
  if (access === "admin") {
    res.status(403).json({
      success: false,
      message: "Admins can view but not send booking messages.",
    });
    return;
  }

  const senderRole = access === "owner-customer" ? "customer" : "technician";
  const message: ChatMessage = {
    id: new ObjectId().toHexString(),
    senderId: new ObjectId(req.user.id),
    senderRole,
    text: parsed.data.text,
    createdAt: new Date(),
    readAt: null,
  };

  const update: Document = {
    $push: {
      "conversation.messages": {
        $each: [message],
        $slice: -CHAT_MESSAGES_CAP,
      },
    },
    $set: { updatedAt: new Date() },
  };
  await getBookingsCollection().updateOne({ _id: bookingId }, update);

  const publicPayload = publicMessage(message);
  // Deliver in real time to anyone viewing this booking room, and to the
  // other participant's user room for list-level badges.
  emitToBookingRoom(bookingId, "chat:message", publicPayload);
  try {
    const recipient = access === "owner-customer" ? booking.technicianId : booking.customerId;
    emitToUser(recipient, "chat:message", {
      bookingId: bookingId.toHexString(),
      message: publicPayload,
    });
  } catch {
    // Delivery failure must never break the REST send path.
  }

  res.status(201).json({
    success: true,
    message: "Message sent.",
    data: publicPayload,
  });
};

export const markChatRead = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const bookingId = parseBookingIdParam(req.params.id);
  if (!bookingId) {
    res.status(400).json({ success: false, message: "Invalid booking id." });
    return;
  }

  const { access, booking } = await resolveAccess(bookingId, req.user);
  if (!access || !booking) {
    res.status(404).json({ success: false, message: "Booking not found." });
    return;
  }

  // Legacy bookings may have no `conversation`, no `messages`, or a `messages`
  // field that is not an array. MongoDB rejects `$[...]` array updates when
  // the targeted path does not exist, so only issue the update when there is
  // actually something to mark. This also makes repeated read calls no-ops.
  const now = new Date();
  const messages = Array.isArray(booking.conversation?.messages)
    ? booking.conversation.messages
    : [];
  const readerId = new ObjectId(req.user.id);
  const readerHexId = readerId.toHexString();
  const hasUnreadFromOther = messages.some(
    (message) =>
      message.senderId.toHexString() !== readerHexId && !message.readAt
  );

  if (hasUnreadFromOther) {
    // Defensive filter: even if the booking changed between load and update,
    // never attempt an array update on a missing/non-array path.
    await getBookingsCollection().updateOne(
      {
        _id: bookingId,
        "conversation.messages": { $type: "array" },
      },
      {
        $set: { "conversation.messages.$[m].readAt": now },
      },
      {
        arrayFilters: [
          {
            "m.senderId": { $ne: readerId },
            "m.readAt": null,
          },
        ],
      }
    );
  }

  emitToBookingRoom(bookingId, "chat:read", {
    bookingId: bookingId.toHexString(),
    readBy: req.user.id,
    readAt: now.toISOString(),
  });

  res.status(200).json({ success: true, message: "Conversation marked as read." });
};
