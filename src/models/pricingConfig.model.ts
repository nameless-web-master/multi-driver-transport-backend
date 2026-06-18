import { DEFAULT_BOOKING_FEE_RATE, DEFAULT_LAND_SPEED_KMH, PRICING_UNITS } from "./pricing.model";

export const PRICING_SETTING_KEYS = {
  booking_fee_rate: "booking_fee_rate",
  land_speed_kmh: "land_speed_kmh",
} as const;

export interface PricingConfigResponse {
  booking_fee_rate: number;
  land_speed_kmh: number;
  units: typeof PRICING_UNITS;
  land_distance_provider: "google" | "h3";
  external_quote_configured: boolean;
}

export interface UpdatePricingConfigRequest {
  booking_fee_rate?: number;
  land_speed_kmh?: number;
}

export const PRICING_DEFAULTS: Omit<
  PricingConfigResponse,
  "land_distance_provider" | "external_quote_configured"
> = {
  booking_fee_rate: DEFAULT_BOOKING_FEE_RATE,
  land_speed_kmh: DEFAULT_LAND_SPEED_KMH,
  units: PRICING_UNITS,
};
