
import type { Collection, ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

export const SERVICES_COLLECTION = "services";

/**
 * The seven exact Assignment 9 categories. Display names === stored values,
 * so the homepage, the filters and the API all speak the same language.
 */
export const SERVICE_CATEGORIES = [
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Older values that may still exist in the database from before the update. */
export const LEGACY_SERVICE_CATEGORIES = [
  "Mobile Repair",
  "Laptop Repair",
  "Refrigerator Repair",
  "AC Repair",
  "TV Repair",
  "Home Appliance Repair",
] as const;

export type LegacyServiceCategory = (typeof LEGACY_SERVICE_CATEGORIES)[number];

/** Every category value a service document is allowed to carry. */
export const ALL_SERVICE_CATEGORIES = [
  ...SERVICE_CATEGORIES,
  ...LEGACY_SERVICE_CATEGORIES,
] as const;

export type AnyServiceCategory = (typeof ALL_SERVICE_CATEGORIES)[number];

/**
 * Unambiguous legacy -> canonical mapping. "Home Appliance Repair" is
 * deliberately excluded: it spans multiple canonical categories and mapping
 * it would require guessing. Such records keep their stored value and remain
 * discoverable (no destructive migration, nothing silently hidden).
 */
export const LEGACY_CATEGORY_MAP: Partial<
  Record<LegacyServiceCategory, ServiceCategory>
> = {
  "Mobile Repair": "Smartphone",
  "Laptop Repair": "Laptop & PC",
  "Refrigerator Repair": "Refrigerator",
  "AC Repair": "AC",
  "TV Repair": "TV",
};

export function isCanonicalCategory(value: string): value is ServiceCategory {
  return (SERVICE_CATEGORIES as readonly string[]).includes(value);
}

/** Canonical value for a legacy alias, or null when there is no safe mapping. */
export function canonicalizeCategory(value: string): ServiceCategory | null {
  if (isCanonicalCategory(value)) return value;
  return LEGACY_CATEGORY_MAP[value as LegacyServiceCategory] ?? null;
}

/** Safe display/normalisation for stored values. */
export function displayCategory(value: string): AnyServiceCategory {
  return canonicalizeCategory(value) ?? (value as AnyServiceCategory);
}

/**
 * Values that a category filter must match. A canonical category also matches
 * its unambiguous legacy aliases so older services stay discoverable.
 */
export function categoryFilterValues(value: string): string[] {
  if (!isCanonicalCategory(value)) return [value];
  const aliases = (Object.entries(LEGACY_CATEGORY_MAP) as Array<
    [LegacyServiceCategory, ServiceCategory]
  >)
    .filter(([, canonical]) => canonical === value)
    .map(([legacy]) => legacy);
  return [value, ...aliases];
}

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
  category: AnyServiceCategory;
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
