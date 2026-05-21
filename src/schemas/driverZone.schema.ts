import { z } from "zod";
import { resolutionSchema } from "./h3.schema";

export const createDriverZoneSchema = z.object({
  driver_name: z.string().trim().min(1, "driver_name is required").max(120),
  zone_name: z.string().trim().min(1, "zone_name is required").max(200),
  resolution: resolutionSchema,
  h3_cells: z.array(z.string()).min(1, "at least one H3 cell is required"),
});

export const updateDriverZoneSchema = z
  .object({
    driver_name: z.string().trim().min(1).max(120).optional(),
    zone_name: z.string().trim().min(1).max(200).optional(),
    resolution: resolutionSchema.optional(),
    h3_cells: z.array(z.string()).min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "at least one field must be provided for update",
  });

export type CreateDriverZoneRequest = z.infer<typeof createDriverZoneSchema>;
export type UpdateDriverZoneRequest = z.infer<typeof updateDriverZoneSchema>;

export interface DriverZoneResponse {
  id: number;
  driver_name: string;
  zone_name: string;
  resolution: number;
  h3_cells: string[];
  cell_count: number;
  created_at: string;
  updated_at: string;
}
