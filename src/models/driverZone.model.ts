import type { Currency } from "./currency.model";
import type { TransportMode } from "./transportMode.model";
import type { SchedulePattern } from "./zoneSchedule.model";

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
  /** Calendar date the zone/route operates (YYYY-MM-DD). @deprecated use operation_start_date */
  operation_date: string | null;
  operation_start_date: string | null;
  operation_end_date: string | null;
  schedule_pattern: SchedulePattern;
  weekday_start: number | null;
  weekday_end: number | null;
  month_day_start: number | null;
  month_day_end: number | null;
  /** Land zones — operating window start (HH:MM). */
  operating_start_time: string | null;
  /** Land zones — operating window end (HH:MM). */
  operating_end_time: string | null;
  /** Milestone 5 — per-zone pricing rules (all nullable; null = not set). */
  base_fee: number | null;
  cost_per_km: number | null;
  cost_per_hour: number | null;
  cost_per_h3_cell: number | null;
  cost_per_kg: number | null;
  cost_per_volume_unit: number | null;
  time_of_day_factor: number | null;
  minimum_fee: number | null;
  currency: Currency;
  available: boolean;
  trust_payment_forwarder: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ZoneRateFields {
  base_fee?: number | null;
  cost_per_km?: number | null;
  cost_per_hour?: number | null;
  cost_per_h3_cell?: number | null;
  cost_per_kg?: number | null;
  cost_per_volume_unit?: number | null;
  time_of_day_factor?: number | null;
  minimum_fee?: number | null;
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
  operation_date?: string | null;
  operation_start_date?: string | null;
  operation_end_date?: string | null;
  schedule_pattern?: SchedulePattern;
  weekday_start?: number | null;
  weekday_end?: number | null;
  month_day_start?: number | null;
  month_day_end?: number | null;
  operating_start_time?: string | null;
  operating_end_time?: string | null;
  base_fee?: number | null;
  cost_per_km?: number | null;
  cost_per_hour?: number | null;
  cost_per_h3_cell?: number | null;
  cost_per_kg?: number | null;
  cost_per_volume_unit?: number | null;
  time_of_day_factor?: number | null;
  minimum_fee?: number | null;
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
  operation_date?: string | null;
  operation_start_date?: string | null;
  operation_end_date?: string | null;
  schedule_pattern?: SchedulePattern;
  weekday_start?: number | null;
  weekday_end?: number | null;
  month_day_start?: number | null;
  month_day_end?: number | null;
  operating_start_time?: string | null;
  operating_end_time?: string | null;
  base_fee?: number | null;
  cost_per_km?: number | null;
  cost_per_hour?: number | null;
  cost_per_h3_cell?: number | null;
  cost_per_kg?: number | null;
  cost_per_volume_unit?: number | null;
  time_of_day_factor?: number | null;
  minimum_fee?: number | null;
  currency?: Currency;
  available?: boolean;
  trust_payment_forwarder?: boolean;
}
