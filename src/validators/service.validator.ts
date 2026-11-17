
import { z } from "zod";
import { SERVICE_CATEGORIES } from "../models/service.model.js";

// Shared field schemas. Strings are trimmed before length checks.
const titleSchema = z
  .string({ error: "Title is required and must be a string" })
  .trim()
  .min(3, "Title must be at least 3 characters long")
  .max(120, "Title must be at most 120 characters long");

const categorySchema = z.enum(SERVICE_CATEGORIES, {
  error: `Category must be one of the supported categories: ${SERVICE_CATEGORIES.join(
    ", "
  )}`,
});

const descriptionSchema = z
  .string({ error: "Description is required and must be a string" })
  .trim()
  .min(10, "Description must be at least 10 characters long")
  .max(2000, "Description must be at most 2000 characters long");

const overviewSchema = z
  .string({ error: "Overview is required and must be a string" })
  .trim()
  .min(10, "Overview must be at least 10 characters long")
  .max(5000, "Overview must be at most 5000 characters long");

const hourlyRateSchema = z
  .number({ error: "Hourly rate must be a number" })
  .finite("Hourly rate must be a finite number")
  .positive("Hourly rate must be greater than 0")
  .max(100000, "Hourly rate must be at most 100000");

const securityDepositSchema = z
  .number({ error: "Security deposit must be a number" })
  .finite("Security deposit must be a finite number")
  .nonnegative("Security deposit cannot be negative")
  .max(1000000, "Security deposit must be at most 1000000");

const maxCapacitySchema = z
  .number({ error: "Max capacity must be a number" })
  .int("Max capacity must be a whole number")
  .min(1, "Max capacity must be at least 1")
  .max(1000, "Max capacity must be at most 1000");

const locationSchema = z
  .string({ error: "Location is required and must be a string" })
  .trim()
  .min(2, "Location must be at least 2 characters long")
  .max(200, "Location must be at most 200 characters long");

const imageSchema = z
  .string({ error: "Image is required and must be a string" })
  .trim()
  .min(1, "Image is required")
  .max(2048, "Image must be at most 2048 characters long");

const amenitySchema = z
  .string({ error: "Each amenity must be a string" })
  .trim()
  .min(1, "Amenities cannot contain empty strings")
  .max(60, "Each amenity must be at most 60 characters long");

const amenitiesSchema = z
  .array(amenitySchema, {
    error: "Amenities must be an array of strings",
  })
  .max(30, "Amenities can contain at most 30 entries");

// Server-controlled fields (technicianId, approvalStatus, …) are
// deliberately absent: z.strictObject rejects any key outside this shape,
// including _id, createdAt, updatedAt and rejectionReason.
const serviceShape = {
  title: titleSchema,
  category: categorySchema,
  description: descriptionSchema,
  overview: overviewSchema,
  hourlyRate: hourlyRateSchema,
  securityDeposit: securityDepositSchema,
  maxCapacity: maxCapacitySchema,
  location: locationSchema,
  image: imageSchema,
  amenities: amenitiesSchema,
};

export const createServiceSchema = z.strictObject({
  ...serviceShape,
  amenities: serviceShape.amenities.optional().default([]),
});

export const updateServiceSchema = z
  .strictObject(serviceShape)
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

// Admin rejection payload. Server-controlled fields (approvalStatus,
// technicianId, _id, createdAt, updatedAt, …) are deliberately absent:
// z.strictObject rejects any key outside this shape.
export const rejectServiceSchema = z.strictObject({
  rejectionReason: z
    .string({ error: "Rejection reason is required and must be a string" })
    .trim()
    .min(1, "Rejection reason cannot be empty")
    .max(500, "Rejection reason must be at most 500 characters long"),
});

export type CreateServiceInput = z.input<typeof createServiceSchema>;
export type UpdateServiceInput = z.input<typeof updateServiceSchema>;
export type RejectServiceInput = z.input<typeof rejectServiceSchema>;
export type CreateServiceData = z.infer<typeof createServiceSchema>;
export type UpdateServiceData = z.infer<typeof updateServiceSchema>;
export type RejectServiceData = z.infer<typeof rejectServiceSchema>;
