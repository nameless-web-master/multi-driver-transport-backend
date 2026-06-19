import { z } from "zod";
import { CURRENCIES, DEFAULT_CURRENCY } from "../models/currency.model";
import { TRANSPORT_MODES } from "../models/transportMode.model";
import { SCHEDULE_PATTERNS } from "../models/zoneSchedule.model";
import { pricingModeSchema } from "./pricingRegion.schema";
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

/** Required HH:MM schedule time. */
const requiredScheduleTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM (24-hour)");

const operationDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const schedulePatternSchema = z.preprocess(
  (val) => (typeof val === "string" ? val.trim().toLowerCase() : val ?? "daily"),
  z.enum(SCHEDULE_PATTERNS)
);

const weekdaySchema = z.coerce.number().int().min(0).max(6).optional().nullable();
const monthDaySchema = z.coerce.number().int().min(1).max(31).optional().nullable();

function refineScheduleFields(
  data: {
    operation_date?: string;
    operation_start_date?: string;
    operation_end_date?: string;
    schedule_pattern?: string;
    weekday_start?: number | null;
    weekday_end?: number | null;
    month_day_start?: number | null;
    month_day_end?: number | null;
  },
  ctx: z.RefinementCtx
): void {
  const start = data.operation_start_date ?? data.operation_date;
  const end = data.operation_end_date ?? data.operation_date ?? start;
  if (!start || !end) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation_start_date"],
      message: "operation_start_date and operation_end_date are required",
    });
    return;
  }
  if (start > end) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation_end_date"],
      message: "operation_end_date must be on or after operation_start_date",
    });
  }
  const pattern = String(data.schedule_pattern ?? "daily");
  if (pattern === "weekly") {
    if (data.weekday_start == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weekday_start"],
        message: "weekday_start is required for weekly schedules",
      });
    }
    if (data.weekday_end == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weekday_end"],
        message: "weekday_end is required for weekly schedules",
      });
    }
  }
  if (pattern === "monthly") {
    if (data.month_day_start == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["month_day_start"],
        message: "month_day_start is required for monthly schedules",
      });
    }
    if (data.month_day_end == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["month_day_end"],
        message: "month_day_end is required for monthly schedules",
      });
    }
  }
}

/** Optional, non-negative pricing field. Coerces "" / null to undefined. */
const rateFieldSchema = z.preprocess(
  (val) => (val === "" || val === null ? undefined : val),
  z
    .number({ invalid_type_error: "rate must be a number" })
    .min(0, "rate must be ≥ 0")
    .max(1_000_000, "rate is too large")
    .optional()
    .nullable()
);

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
  operation_date: operationDateSchema.optional(),
  operation_start_date: operationDateSchema,
  operation_end_date: operationDateSchema,
  schedule_pattern: schedulePatternSchema.optional().default("daily"),
  weekday_start: weekdaySchema,
  weekday_end: weekdaySchema,
  month_day_start: monthDaySchema,
  month_day_end: monthDaySchema,
  operating_start_time: scheduleTimeSchema,
  operating_end_time: scheduleTimeSchema,
  // Pricing engine — base cost, travel rate (per km), wage (per hour).
  base_fee: rateFieldSchema,
  cost_per_km: rateFieldSchema,
  cost_per_hour: rateFieldSchema,
  // Legacy fields kept for backward compatibility; not used by the pricing engine.
  cost_per_h3_cell: rateFieldSchema,
  cost_per_kg: rateFieldSchema,
  cost_per_volume_unit: rateFieldSchema,
  time_of_day_factor: rateFieldSchema,
  minimum_fee: rateFieldSchema,
  currency: currencySchema.optional().default(DEFAULT_CURRENCY),
  pricing_mode: pricingModeSchema.optional().default("system"),
  pricing_region_id: z.coerce.number().int().positive().optional().nullable(),
  available: z.boolean(),
  trust_payment_forwarder: z.boolean(),
};

function refinePricingFields(
  data: {
    pricing_mode?: string;
    pricing_region_id?: number | null;
    base_fee?: number | null;
    cost_per_km?: number | null;
    cost_per_hour?: number | null;
  },
  ctx: z.RefinementCtx
): void {
  const mode = data.pricing_mode ?? "system";
  if (mode !== "system") return;
  const hasRegion = data.pricing_region_id != null;
  const hasRate =
    data.base_fee != null || data.cost_per_km != null || data.cost_per_hour != null;
  if (!hasRegion && !hasRate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pricing_region_id"],
      message:
        "System pricing requires a pricing region or at least one rate (base, cost per km, or cost per hour)",
    });
  }
}

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
    refineScheduleFields(data, ctx);
    refinePricingFields(data, ctx);
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
      if (!data.departure_time) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["departure_time"],
          message: "departure_time is required for air/sea routes",
        });
      }
      if (!data.arrival_time) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["arrival_time"],
          message: "arrival_time is required for air/sea routes",
        });
      }
      return;
    }
    if (!data.operating_start_time) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operating_start_time"],
        message: "operating_start_time is required for land zones",
      });
    }
    if (!data.operating_end_time) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operating_end_time"],
        message: "operating_end_time is required for land zones",
      });
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
    operation_date: operationDateSchema.optional(),
    operation_start_date: operationDateSchema.optional(),
    operation_end_date: operationDateSchema.optional(),
    schedule_pattern: schedulePatternSchema.optional(),
    weekday_start: weekdaySchema,
    weekday_end: weekdaySchema,
    month_day_start: monthDaySchema,
    month_day_end: monthDaySchema,
    operating_start_time: scheduleTimeSchema,
    operating_end_time: scheduleTimeSchema,
    base_fee: rateFieldSchema,
    cost_per_km: rateFieldSchema,
    cost_per_hour: rateFieldSchema,
    cost_per_h3_cell: rateFieldSchema,
    cost_per_kg: rateFieldSchema,
    cost_per_volume_unit: rateFieldSchema,
    time_of_day_factor: rateFieldSchema,
    minimum_fee: rateFieldSchema,
    currency: currencySchema.optional(),
    pricing_mode: pricingModeSchema.optional(),
    pricing_region_id: z.coerce.number().int().positive().optional().nullable(),
    available: z.boolean().optional(),
    trust_payment_forwarder: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "at least one field must be provided for update",
  })
  .superRefine((data, ctx) => {
    if (
      data.operation_start_date !== undefined ||
      data.operation_end_date !== undefined ||
      data.operation_date !== undefined ||
      data.schedule_pattern !== undefined ||
      data.weekday_start !== undefined ||
      data.weekday_end !== undefined ||
      data.month_day_start !== undefined ||
      data.month_day_end !== undefined
    ) {
      refineScheduleFields(data, ctx);
    }
  });

export type CreateDriverZoneRequest = z.infer<typeof createDriverZoneSchema>;
export type UpdateDriverZoneRequest = z.infer<typeof updateDriverZoneSchema>;
export type HubTerminal = z.infer<typeof hubTerminalSchema>;

export const setOwnerZonesAvailabilitySchema = z.object({
  available: z.boolean(),
});

export type SetOwnerZonesAvailabilityRequest = z.infer<typeof setOwnerZonesAvailabilitySchema>;

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
  operation_date: string | null;
  operation_start_date: string | null;
  operation_end_date: string | null;
  schedule_pattern: string;
  weekday_start: number | null;
  weekday_end: number | null;
  month_day_start: number | null;
  month_day_end: number | null;
  operating_start_time: string | null;
  operating_end_time: string | null;
  base_fee: number | null;
  cost_per_km: number | null;
  cost_per_hour: number | null;
  cost_per_h3_cell: number | null;
  cost_per_kg: number | null;
  cost_per_volume_unit: number | null;
  time_of_day_factor: number | null;
  minimum_fee: number | null;
  currency: string;
  pricing_mode: string;
  pricing_region_id: number | null;
  pricing_region_name?: string | null;
  region_rates?: {
    base_fee: number | null;
    cost_per_km: number | null;
    cost_per_hour: number | null;
  } | null;
  /** Effective rates after merging zone overrides with regional defaults. */
  effective_base_fee?: number | null;
  effective_cost_per_km?: number | null;
  effective_cost_per_hour?: number | null;
  available: boolean;
  trust_payment_forwarder: boolean;
  driver_trustworthiness?: number;
  /** True when the zone schedule is complete and the current time is within the window. */
  schedule_active?: boolean;
  created_at: string;
  updated_at: string;
}
