import { z } from "zod";
import { CURRENCIES, DEFAULT_CURRENCY } from "../models/currency.model";

const rateFieldSchema = z.preprocess(
  (val) => (val === "" || val === null ? undefined : val),
  z
    .number({ invalid_type_error: "rate must be a number" })
    .min(0, "rate must be ≥ 0")
    .max(1_000_000, "rate is too large")
    .optional()
    .nullable()
);

export const pricingModeSchema = z.enum(["system", "manual"]);

export const createPricingRegionSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  base_fee: rateFieldSchema,
  cost_per_km: rateFieldSchema,
  cost_per_hour: rateFieldSchema,
  currency: z.preprocess(
    (val) => (typeof val === "string" ? val.trim().toUpperCase() : val),
    z.enum(CURRENCIES).optional().default(DEFAULT_CURRENCY)
  ),
});

export const updatePricingRegionSchema = createPricingRegionSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: "at least one field must be provided for update" }
);

export type CreatePricingRegionRequest = z.infer<typeof createPricingRegionSchema>;
export type UpdatePricingRegionRequest = z.infer<typeof updatePricingRegionSchema>;
