import { z } from "zod";
import { TRANSPORT_MODES } from "../models/transportMode.model";
import { CURRENCIES } from "../models/currency.model";

const nonNegative = z
  .number({ invalid_type_error: "Must be a number" })
  .min(0, "Must be >= 0");

const positive = z
  .number({ invalid_type_error: "Must be a number" })
  .positive("Must be > 0");

export const createRateTableSchema = z.object({
  transporter_id: z.number().int().positive().optional(),
  transport_method: z.enum(TRANSPORT_MODES),
  currency: z.enum(CURRENCIES).optional().default("CAD"),
  base_fee: nonNegative.optional().default(0),
  cost_per_h3_cell: nonNegative.nullable().optional(),
  cost_per_km: nonNegative.nullable().optional(),
  cost_per_kg: nonNegative.nullable().optional(),
  cost_per_volume_unit: nonNegative.nullable().optional(),
  time_of_day_factor: nonNegative.nullable().optional(),
  minimum_fee: nonNegative.nullable().optional(),
  is_active: z.boolean().optional().default(true),
});

export const updateRateTableSchema = createRateTableSchema.partial();

export const manualSegmentCostSchema = z.object({
  manual_cost: nonNegative,
});

export type CreateRateTableRequest = z.infer<typeof createRateTableSchema>;
export type UpdateRateTableRequest = z.infer<typeof updateRateTableSchema>;
export type ManualSegmentCostRequest = z.infer<typeof manualSegmentCostSchema>;

export { positive as packagePositiveNumber };
