
import type { Server as HttpServer } from "node:http";
import { Server as SocketServer, type Socket } from "socket.io";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { env } from "./config/env.js";
import { getUsersCollection } from "./models/technician-application.model.js";
import { getBookingsCollection } from "./models/booking.model.js";

/**
 * Socket.IO real-time layer (authenticated, role-aware).
 *
 * Authentication mirrors src/middleware/verifyToken.ts exactly: the client
 * passes the Better Auth JWT (obtained from /api/auth/token) in the socket
 * handshake as `auth.token`. The token is verified against the Better Auth
 * JWKS with issuer/audience = BETTER_AUTH_URL, and the role is re-read from
 * the database on every connection — never trusted from the token claim.
 *
 * Clients never supply their user id: identity comes exclusively from the
 * verified token. Rooms are per-user (`user:<hex>`) and per-booking
 * (`booking:<hex>`); joining a booking room requires the same ownership or
 * admin authorization the REST chat endpoints enforce.
 *
 * Notification/chat DELIVERY goes over sockets; chat SENDING goes over REST
 * (rate-limited with express-rate-limit) — sockets never accept payload
 * writes, which keeps the abuse surface small.
 */

const JWKS_URL = `${env.BETTER_AUTH_URL}/api/auth/jwks`;
const JWKS = createRemoteJWKSet(new URL(JWKS_URL), {
  cacheMaxAge: 10 * 60 * 1000,
  cooldownDuration: 30 * 1000,
  timeoutDuration: 5000,
});

export interface SocketIdentity {
  userId: string;
  email: string;
  role: string;
}

interface SocketData {
  userId: string;
  role: string;
}

let io: SocketServer | null = null;

const extractToken = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Compact JWS: three base64url segments separated by dots.
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)
    ? trimmed
    : null;
};

const verifySocketToken = async (token: string): Promise<SocketIdentity | null> => {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.BETTER_AUTH_URL,
      audience: env.BETTER_AUTH_URL,
    });
    const id = payload.id;
    const email = payload.email;
    const role = payload.role;
    if (
      typeof id !== "string" ||
      !id ||
      typeof email !== "string" ||
      !email ||
      typeof role !== "string" ||
      !role
    ) {
      return null;
    }
    if (!ObjectId.isValid(id)) {
      return null;
    }

    // Fresh DB role — the token claim is not trusted (mirrors verifyToken).
    const dbUser = await getUsersCollection().findOne(
      { _id: new ObjectId(id) },
      { projection: { role: 1 } }
    );
    if (!dbUser) return null;
    const currentRole =
      typeof dbUser.role === "string" && dbUser.role.trim().length > 0
        ? dbUser.role
        : "customer";

    return { userId: id, email, role: currentRole };
  } catch {
    return null;
  }
};

const isAdmin = (role: string): boolean => role === "admin";

export const toUserRoom = (userId: string): string => `user:${userId}`;
export const toBookingRoom = (bookingId: string): string => `booking:${bookingId}`;

/** Emit to a specific user's room. No-op when sockets are not initialized. */
export const emitToUser = (
  userId: string | ObjectId,
  event: string,
  payload: unknown
): void => {
  if (!io) return;
  const hex = typeof userId === "string" ? userId : userId.toHexString();
  io.to(toUserRoom(hex)).emit(event, payload);
};

/** Emit to a booking room (participants + admins who joined). */
export const emitToBookingRoom = (
  bookingId: string | ObjectId,
  event: string,
  payload: unknown
): void => {
  if (!io) return;
  const hex = typeof bookingId === "string" ? bookingId : bookingId.toHexString();
  io.to(toBookingRoom(hex)).emit(event, payload);
};

/** Resolve the booking access rule shared by REST/socket gates. */
const canAccessBooking = async (
  bookingId: ObjectId,
  identity: SocketData
): Promise<boolean> => {
  if (isAdmin(identity.role)) {
    // Admins may observe any booking conversation.
    const exists = await getBookingsCollection().findOne(
      { _id: bookingId },
      { projection: { _id: 1 } }
    );
    return Boolean(exists);
  }
  const participant = await getBookingsCollection().findOne(
    {
      _id: bookingId,
      $or: [
        { customerId: new ObjectId(identity.userId) },
        { technicianId: new ObjectId(identity.userId) },
      ],
    },
    { projection: { _id: 1 } }
  );
  return Boolean(participant);
};

export const initSocketServer = (server: HttpServer): SocketServer => {
  io = new SocketServer(server, {
    path: "/socket.io",
    cors: {
      origin: env.CLIENT_URL,
      credentials: true,
    },
    // Never accept large frames for a JSON control/notify channel.
    maxHttpBufferSize: 16 * 1024,
    transports: ["polling", "websocket"],
  });

  io.use(async (socket, next) => {
    const token = extractToken(socket.handshake.auth?.token);
    if (!token) {
      next(new Error("Authentication token is required."));
      return;
    }
    const identity = await verifySocketToken(token);
    if (!identity) {
      next(new Error("Invalid or expired token."));
      return;
    }
    (socket.data as SocketData) = {
      userId: identity.userId,
      role: identity.role,
    };
    next();
  });

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;
    socket.join(toUserRoom(data.userId));

    // Join a booking's chat/notification room — authorized participants only.
    socket.on(
      "join:booking",
      async (payload: unknown, ack?: (result: { success: boolean; message?: string }) => void) => {
        const raw = typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).bookingId
          : undefined;
        const bookingHex = typeof raw === "string" ? raw : "";
        if (!/^[0-9a-fA-F]{24}$/.test(bookingHex)) {
          ack?.({ success: false, message: "Invalid booking id." });
          return;
        }
        const bookingId = new ObjectId(bookingHex);
        const allowed = await canAccessBooking(bookingId, data).catch(() => false);
        if (!allowed) {
          ack?.({ success: false, message: "You are not a participant of this booking." });
          return;
        }
        await socket.join(toBookingRoom(bookingHex));
        ack?.({ success: true });
      }
    );

    socket.on("leave:booking", (payload: unknown) => {
      const raw = typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).bookingId
        : undefined;
      const bookingHex = typeof raw === "string" ? raw : "";
      if (/^[0-9a-fA-F]{24}$/.test(bookingHex)) {
        void socket.leave(toBookingRoom(bookingHex));
      }
    });
  });

  return io;
};

export const getSocketServer = (): SocketServer | null => io;

export const closeSocketServer = async (): Promise<void> => {
  if (!io) return;
  const current = io;
  io = null;
  await new Promise<void>((resolve, reject) => {
    current.close((err) => (err ? reject(err) : resolve()));
  });
};
