import { z } from "zod";

export const latitudeSchema = z
  .number({ invalid_type_error: "latitude must be a number" })
  .min(-90)
  .max(90);

export const longitudeSchema = z
  .number({ invalid_type_error: "longitude must be a number" })
  .min(-180)
  .max(180);

export const resolutionSchema = z
  .number({ invalid_type_error: "resolution must be a number" })
  .int()
  .min(0)
  .max(15);

export const convertRequestSchema = z.object({
  pickup_lat: latitudeSchema,
  pickup_lng: longitudeSchema,
  dropoff_lat: latitudeSchema,
  dropoff_lng: longitudeSchema,
  resolution: resolutionSchema,
});

export type ConvertRequest = z.infer<typeof convertRequestSchema>;

export interface ConvertResponse {
  pickup_h3: string;
  dropoff_h3: string;
  resolution: number;
  cell_type: "Hexagon";
  pickup_center: { lat: number; lng: number };
  dropoff_center: { lat: number; lng: number };
}
