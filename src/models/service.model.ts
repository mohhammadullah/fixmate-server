
import type { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

export const SERVICES_COLLECTION = "services";

export const SERVICE_CATEGORIES = [
  "Mobile Repair",
  "Laptop Repair",
  "Refrigerator Repair",
  "AC Repair",
  "TV Repair",
  "Home Appliance Repair",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const SERVICE_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;

export type ServiceApprovalStatus = (typeof SERVICE_APPROVAL_STATUSES)[number];

export const SERVICE_AVAILABILITY_STATUSES = [
  "available",
  "unavailable",
] as const;

export type ServiceAvailabilityStatus =
  (typeof SERVICE_AVAILABILITY_STATUSES)[number];

export interface Service {
  _id: ObjectId;
  title: string;
  category: ServiceCategory;
  description: string;
  overview: string;
  hourlyRate: number;
  securityDeposit: number;
  maxCapacity: number;
  location: string;
  image: string;
  amenities: string[];
  technicianId: ObjectId;
  technicianName: string;
  technicianEmail: string;
  approvalStatus: ServiceApprovalStatus;
  availabilityStatus: ServiceAvailabilityStatus;
  // Present only when approvalStatus is "rejected".
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Document shape for inserts: the server assigns _id and timestamps.
export type ServiceInsert = Omit<Service, "_id" | "createdAt" | "updatedAt">;

export const getServicesCollection = (): Collection<Service> =>
  getDB().collection<Service>(SERVICES_COLLECTION);
