import { z } from "zod";
import { latitudeSchema, longitudeSchema } from "./h3.schema";

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
  weight_kg: z
    .number({ invalid_type_error: "weight_kg must be a number" })
    .positive("Weight must be greater than 0")
    .max(1_000_000)
    .optional()
    .nullable(),
  package_weight_unit: z.string().trim().max(10).optional().default("kg"),
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
  package_dimension_unit: z.string().trim().max(10).optional().default("cm"),
  dimensions: z.string().trim().max(120).optional().default(""),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["delivering", "received"]),
});

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusRequest = z.infer<typeof updateOrderStatusSchema>;
