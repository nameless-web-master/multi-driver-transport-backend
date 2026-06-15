import type { TransportMode } from "./transportMode.model";

export interface RateTableRow {
  id: number;
  transporter_id: number;
  transport_method: TransportMode;
  currency: string;
  base_fee: number;
  cost_per_h3_cell: number | null;
  cost_per_km: number | null;
  cost_per_kg: number | null;
  cost_per_volume_unit: number | null;
  time_of_day_factor: number | null;
  minimum_fee: number | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RateTableResponse {
  id: number;
  transporter_id: number;
  transporter_name?: string;
  transport_method: TransportMode;
  currency: string;
  base_fee: number;
  cost_per_h3_cell: number | null;
  cost_per_km: number | null;
  cost_per_kg: number | null;
  cost_per_volume_unit: number | null;
  time_of_day_factor: number | null;
  minimum_fee: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
