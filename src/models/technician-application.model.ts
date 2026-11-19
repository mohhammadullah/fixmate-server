import type { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

// Better Auth stores users in the singular `user` collection. Technician
// applications live as a structured subdocument on that document — no
// additional application collection is introduced.
export const USERS_COLLECTION = "user";

export const APPLICATION_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface TechnicianApplication {
  status: ApplicationStatus;
  experience: number;
  skills: string[];
  submittedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: ObjectId;
  rejectionReason?: string;
}

export interface UserWithApplication {
  _id: ObjectId;
  name?: string;
  email?: string;
  role?: string;
  phone?: string;
  area?: string;
  bio?: string;
  /** Hosted avatar URL managed via /api/users/me/image (Better Auth's
   *  default `image` field). null when no photo is set. */
  image?: string | null;
  technicianApplication?: TechnicianApplication;
  [key: string]: unknown;
}

export const getUsersCollection = (): Collection<UserWithApplication> =>
  getDB().collection<UserWithApplication>(USERS_COLLECTION);
