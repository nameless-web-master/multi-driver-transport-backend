import { z } from "zod";
import { CURRENCIES, DEFAULT_CURRENCY } from "../models/currency.model";
import { TRANSPORT_MODES } from "../models/transportMode.model";
import { resolutionSchema } from "./h3.schema";
import { latLngPointSchema } from "./h3Polygon.schema";

export const transportModeSchema = z.preprocess(
  (val) => (typeof val === "string" ? val.trim().toLowerCase() : val),
  z.enum(TRANSPORT_MODES)
);

/** Uppercase the input first so 'usd' / 'Usd' resolve to 'USD'. */
export const currencySchema = z.preprocess(
  (val) => (typeof val === "string" ? val.trim().toUpperCase() : val),
  z.enum(CURRENCIES)
);

/** A named terminal hub (airport or port) with lat/lng coordinates. */
export const hubTerminalSchema = z.object({
  name: z.string().trim().min(1, "hub name is required").max(120),
  lat: z.coerce
    .number({ invalid_type_error: "hub lat must be a number" })
    .min(-90)
    .max(90),
  lng: z.coerce
    .number({ invalid_type_error: "hub lng must be a number" })
    .min(-180)
    .max(180),
});

/** Optional HH:MM schedule time. */
const scheduleTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM (24-hour)")
  .optional()
  .nullable();

const zoneBaseFields = {
  driver_name: z.string().trim().min(1, "driver_name is required").max(120),
  zone_name: z.string().trim().min(1, "zone_name is required").max(200),
  resolution: resolutionSchema,
  transport_mode: transportModeSchema,
  boundary: z.array(latLngPointSchema).min(3).optional().nullable(),
  departure_hub: hubTerminalSchema.optional().nullable(),
  arrival_hub: hubTerminalSchema.optional().nullable(),
  departure_time: scheduleTimeSchema,
  arrival_time: scheduleTimeSchema,
  rate_cost: z
    .number({ invalid_type_error: "rate_cost must be a number" })
    .min(0, "rate_cost must be ≥ 0")
    .max(1_000_000, "rate_cost is too large"),
  currency: currencySchema.optional().default(DEFAULT_CURRENCY),
  available: z.boolean(),
  trust_payment_forwarder: z.boolean(),
};

function isHubTransportMode(mode: string): boolean {
  return mode === "air" || mode === "sea";
}

/** Air/sea by mode, or any create payload that already includes both terminals. */
function isHubRoutePayload(data: {
  transport_mode: string;
  departure_hub?: z.infer<typeof hubTerminalSchema> | null;
  arrival_hub?: z.infer<typeof hubTerminalSchema> | null;
}): boolean {
  return (
    isHubTransportMode(data.transport_mode) ||
    (!!data.departure_hub && !!data.arrival_hub)
  );
}

export const createDriverZoneSchema = z
  .object({
    ...zoneBaseFields,
    h3_cells: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    if (isHubRoutePayload(data)) {
      if (!data.departure_hub) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["departure_hub"],
          message: "departure_hub is required for air/sea routes",
        });
      }
      if (!data.arrival_hub) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["arrival_hub"],
          message: "arrival_hub is required for air/sea routes",
        });
      }
      if (
        data.departure_hub &&
        data.arrival_hub &&
        !isHubTransportMode(data.transport_mode)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transport_mode"],
          message: "transport_mode must be air or sea when departure and arrival hubs are set",
        });
      }
      return;
    }
    const hasCells = (data.h3_cells?.length ?? 0) > 0;
    const hasBoundary = (data.boundary?.length ?? 0) >= 3;
    if (!hasCells && !hasBoundary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["h3_cells"],
        message: "provide h3_cells or a geofence boundary (min 3 points) for land zones",
      });
    }
  });

export const updateDriverZoneSchema = z
  .object({
    driver_name: z.string().trim().min(1).max(120).optional(),
    zone_name: z.string().trim().min(1).max(200).optional(),
    resolution: resolutionSchema.optional(),
    h3_cells: z.array(z.string()).min(1).optional(),
    transport_mode: transportModeSchema.optional(),
    boundary: z.array(latLngPointSchema).min(3).optional().nullable(),
    departure_hub: hubTerminalSchema.optional().nullable(),
    arrival_hub: hubTerminalSchema.optional().nullable(),
    departure_time: scheduleTimeSchema,
    arrival_time: scheduleTimeSchema,
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
export type HubTerminal = z.infer<typeof hubTerminalSchema>;

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
  departure_hub: HubTerminal | null;
  arrival_hub: HubTerminal | null;
  departure_time: string | null;
  arrival_time: string | null;
  rate_cost: number;
  currency: string;
  available: boolean;
  trust_payment_forwarder: boolean;
  driver_trustworthiness?: number;
  created_at: string;
  updated_at: string;
}
