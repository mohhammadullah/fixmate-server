import { z } from "zod";

// Strict client-editable profile fields. Email, role and the technician
// application subdocument are server-controlled and rejected by this shape.
const optionalTrimmed = (max: number, label: string) =>
  z
    .string({ error: `${label} must be a string` })
    .trim()
    .max(max, `${label} must be at most ${max} characters long`)
    .optional();

export const updateProfileSchema = z
  .strictObject({
    name: z
      .string({ error: "Name must be a string" })
      .trim()
      .min(1, "Name cannot be empty")
      .max(100, "Name must be at most 100 characters long")
      .optional(),
    phone: z
      .union([
        z.literal(""),
        z
          .string({ error: "Phone must be a string" })
          .trim()
          .regex(/^[0-9+\-()\s]{5,30}$/, "Phone must be 5–30 characters using digits, +, -, ( ) or spaces"),
      ])
      .optional(),
    area: optionalTrimmed(120, "Area"),
    bio: optionalTrimmed(1000, "Bio"),
    // Approximate location — stored only with explicit user consent. Never
    // exposed publicly; used for area/distance matching server-side.
    location: z
      .strictObject({
        area: z.string({ error: "Area must be a string" }).trim().max(120).optional(),
        coordinates: z
          .strictObject({
            lat: z
              .number({ error: "lat must be a number" })
              .min(-90, "lat must be between -90 and 90")
              .max(90, "lat must be between -90 and 90"),
            lng: z
              .number({ error: "lng must be a number" })
              .min(-180, "lng must be between -180 and 180")
              .max(180, "lng must be between -180 and 180"),
          })
          .refine((value) => Number.isFinite(value.lat) && Number.isFinite(value.lng), {
            message: "coordinates must be finite numbers",
          })
          .optional(),
      })
      .refine((value) => value.area !== undefined || value.coordinates !== undefined, {
        message: "location requires at least an area or coordinates",
      })
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
    path: ["name"],
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
