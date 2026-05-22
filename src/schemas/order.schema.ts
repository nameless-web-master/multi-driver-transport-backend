import { z } from "zod";
import { latitudeSchema, longitudeSchema } from "./h3.schema";

export const createOrderSchema = z.object({
  receiver_user_id: z.number().int().positive(),
  sender_address: z.string().trim().max(300).optional().default(""),
  sender_lat: latitudeSchema.optional().nullable(),
  sender_lng: longitudeSchema.optional().nullable(),
  notes: z.string().trim().max(1000).optional().default(""),
  driver_user_id: z.number().int().positive().optional().nullable(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["delivering", "received"]),
});

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusRequest = z.infer<typeof updateOrderStatusSchema>;
