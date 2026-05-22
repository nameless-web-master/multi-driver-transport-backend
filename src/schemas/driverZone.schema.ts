import { z } from "zod";
import { CURRENCIES, DEFAULT_CURRENCY } from "../models/currency.model";
import { TRANSPORT_MODES } from "../models/transportMode.model";
import { resolutionSchema } from "./h3.schema";
import { latLngPointSchema } from "./h3Polygon.schema";

export const transportModeSchema = z.enum(TRANSPORT_MODES);

/** Uppercase the input first so 'usd' / 'Usd' resolve to 'USD'. */
export const currencySchema = z.preprocess(
  (val) => (typeof val === "string" ? val.trim().toUpperCase() : val),
  z.enum(CURRENCIES)
);

const zoneBaseFields = {
  driver_name: z.string().trim().min(1, "driver_name is required").max(120),
  zone_name: z.string().trim().min(1, "zone_name is required").max(200),
  resolution: resolutionSchema,
  transport_mode: transportModeSchema,
  boundary: z.array(latLngPointSchema).min(3).optional().nullable(),
  rate_cost: z
    .number({ invalid_type_error: "rate_cost must be a number" })
    .min(0, "rate_cost must be ≥ 0")
    .max(1_000_000, "rate_cost is too large"),
  currency: currencySchema.optional().default(DEFAULT_CURRENCY),
  available: z.boolean(),
  trust_payment_forwarder: z.boolean(),
};

export const createDriverZoneSchema = z
  .object({
    ...zoneBaseFields,
    h3_cells: z.array(z.string()).optional(),
  })
  .refine((data) => (data.h3_cells?.length ?? 0) > 0 || (data.boundary?.length ?? 0) >= 3, {
    message: "provide h3_cells or a geofence boundary (min 3 points)",
    path: ["h3_cells"],
  });

export const updateDriverZoneSchema = z
  .object({
    driver_name: z.string().trim().min(1).max(120).optional(),
    zone_name: z.string().trim().min(1).max(200).optional(),
    resolution: resolutionSchema.optional(),
    h3_cells: z.array(z.string()).min(1).optional(),
    transport_mode: transportModeSchema.optional(),
    boundary: z.array(latLngPointSchema).min(3).optional().nullable(),
    rate_cost: z.number().min(0).max(1_000_000).optional(),
    currency: currencySchema.optional(),
    available: z.boolean().optional(),
    trust_payment_forwarder: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "at least one field must be provided for update",
  });

export type CreateDriverZoneRequest = z.infer<typeof createDriverZoneSchema>;
export type UpdateDriverZoneRequest = z.infer<typeof updateDriverZoneSchema>;

export interface DriverZoneResponse {
  id: number;
  owner_user_id: number;
  driver_name: string;
  zone_name: string;
  resolution: number;
  h3_cells: string[];
  cell_count: number;
  transport_mode: string;
  boundary: { lat: number; lng: number }[] | null;
  rate_cost: number;
  currency: string;
  available: boolean;
  trust_payment_forwarder: boolean;
  driver_trustworthiness?: number;
  created_at: string;
  updated_at: string;
}
