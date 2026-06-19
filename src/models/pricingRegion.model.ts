import type { Currency } from "./currency.model";

export type ZonePricingMode = "system" | "manual";

export interface PricingRegionRow {
  id: number;
  name: string;
  base_fee: number | null;
  cost_per_km: number | null;
  cost_per_hour: number | null;
  currency: Currency;
  created_at: Date;
  updated_at: Date;
}

export interface PricingRegionResponse {
  id: number;
  name: string;
  base_fee: number | null;
  cost_per_km: number | null;
  cost_per_hour: number | null;
  currency: Currency;
  created_at: string;
  updated_at: string;
}

export interface RegionRateDefaults {
  base_fee: number | null;
  cost_per_km: number | null;
  cost_per_hour: number | null;
  currency: string;
}
