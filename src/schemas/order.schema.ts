import { z } from "zod";
import { latitudeSchema, longitudeSchema } from "./h3.schema";
import { PACKAGE_TYPES, packageFactorForType } from "../models/package.model";

export const packageTypeSchema = z.enum(PACKAGE_TYPES);

export const createOrderSchema = z.object({
  receiver_user_id: z.number().int().positive(),
  sender_address: z.string().trim().max(300).optional().default(""),
  sender_lat: latitudeSchema.optional().nullable(),
  sender_lng: longitudeSchema.optional().nullable(),
  notes: z.string().trim().max(1000).optional().default(""),
  driver_user_id: z.number().int().positive().optional().nullable(),
  // ---- Milestone 1 (updated scope): basic order form fields. ----
  source_name: z.string().trim().max(200).optional().default(""),
  source_contact: z.string().trim().max(120).optional().default(""),
  payment_method: z.string().trim().max(60).optional().default(""),
  shipping_method: z.string().trim().max(60).optional().default(""),
  package_description: z.string().trim().max(1000).optional().default(""),
  package_type: packageTypeSchema,
  weight_lbs: z
    .number({ invalid_type_error: "weight_lbs must be a number" })
    .positive("Weight must be greater than 0")
    .max(1_000_000)
    .optional()
    .nullable(),
  package_weight_unit: z.literal("lb").optional().default("lb"),
  package_length: z
    .number({ invalid_type_error: "package_length must be a number" })
    .positive("Length must be greater than 0")
    .max(1_000_000)
    .optional()
    .nullable(),
  package_width: z
    .number({ invalid_type_error: "package_width must be a number" })
    .positive("Width must be greater than 0")
    .max(1_000_000)
    .optional()
    .nullable(),
  package_height: z
    .number({ invalid_type_error: "package_height must be a number" })
    .positive("Height must be greater than 0")
    .max(1_000_000)
    .optional()
    .nullable(),
  package_dimension_unit: z.literal("in").optional().default("in"),
  dimensions: z.string().trim().max(120).optional().default(""),
}).superRefine((data, ctx) => {
  if (data.package_weight_unit && data.package_weight_unit !== "lb") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["package_weight_unit"],
      message: "Weight unit must be lb (pounds)",
    });
  }
  if (data.package_dimension_unit && data.package_dimension_unit !== "in") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["package_dimension_unit"],
      message: "Dimension unit must be in (inches)",
    });
  }
  const weight = data.weight_lbs;
  if (weight == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["weight_lbs"],
      message: "Weight (lbs) is required",
    });
  }
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["delivering", "received"]),
});

export const updateOrderPackageSchema = z
  .object({
    package_type: packageTypeSchema.optional(),
    weight_lbs: z
      .number({ invalid_type_error: "weight_lbs must be a number" })
      .positive("Weight must be greater than 0")
      .max(1_000_000)
      .optional()
      .nullable(),
    package_length: z
      .number({ invalid_type_error: "package_length must be a number" })
      .positive("Length must be greater than 0")
      .max(1_000_000)
      .optional()
      .nullable(),
    package_width: z
      .number({ invalid_type_error: "package_width must be a number" })
      .positive("Width must be greater than 0")
      .max(1_000_000)
      .optional()
      .nullable(),
    package_height: z
      .number({ invalid_type_error: "package_height must be a number" })
      .positive("Height must be greater than 0")
      .max(1_000_000)
      .optional()
      .nullable(),
    package_description: z.string().trim().max(1000).optional(),
    dimensions: z.string().trim().max(120).optional(),
  })
  .superRefine((data, ctx) => {
    const hasField =
      data.package_type != null ||
      data.weight_lbs !== undefined ||
      data.package_length !== undefined ||
      data.package_width !== undefined ||
      data.package_height !== undefined ||
      data.package_description !== undefined ||
      data.dimensions !== undefined;
    if (!hasField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one package field to update",
      });
    }
  });

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusRequest = z.infer<typeof updateOrderStatusSchema>;
export type UpdateOrderPackageRequest = z.infer<typeof updateOrderPackageSchema>;
