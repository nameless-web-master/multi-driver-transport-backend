import type { Currency } from "./currency.model";
import type { TransportMode } from "./transportMode.model";

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface DriverZoneRow {
  id: number;
  owner_user_id: number;
  driver_name: string;
  zone_name: string;
  resolution: number;
  h3_cells: string[];
  transport_mode: TransportMode;
  boundary: LatLngPoint[] | null;
  rate_cost: number;
  currency: Currency;
  available: boolean;
  trust_payment_forwarder: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface DriverZoneCreateInput {
  owner_user_id: number;
  driver_name: string;
  zone_name: string;
  resolution: number;
  h3_cells: string[];
  transport_mode: TransportMode;
  boundary?: LatLngPoint[] | null;
  rate_cost: number;
  currency: Currency;
  available: boolean;
  trust_payment_forwarder: boolean;
}

export interface DriverZoneUpdateInput {
  driver_name?: string;
  zone_name?: string;
  resolution?: number;
  h3_cells?: string[];
  transport_mode?: TransportMode;
  boundary?: LatLngPoint[] | null;
  rate_cost?: number;
  currency?: Currency;
  available?: boolean;
  trust_payment_forwarder?: boolean;
}
