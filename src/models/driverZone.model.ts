import type { Currency } from "./currency.model";
import type { TransportMode } from "./transportMode.model";

export interface LatLngPoint {
  lat: number;
  lng: number;
}

/** A named terminal hub (airport or port) with coordinates. */
export interface HubTerminal {
  name: string;
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
  /** Departure terminal — required for air/sea routes. */
  departure_hub: HubTerminal | null;
  /** Arrival terminal — required for air/sea routes. */
  arrival_hub: HubTerminal | null;
  departure_time: string | null;
  arrival_time: string | null;
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
  departure_hub?: HubTerminal | null;
  arrival_hub?: HubTerminal | null;
  departure_time?: string | null;
  arrival_time?: string | null;
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
  departure_hub?: HubTerminal | null;
  arrival_hub?: HubTerminal | null;
  departure_time?: string | null;
  arrival_time?: string | null;
  rate_cost?: number;
  currency?: Currency;
  available?: boolean;
  trust_payment_forwarder?: boolean;
}
