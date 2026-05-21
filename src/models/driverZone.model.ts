export interface DriverZoneRow {
  id: number;
  driver_name: string;
  zone_name: string;
  resolution: number;
  h3_cells: string[];
  created_at: Date;
  updated_at: Date;
}

export interface DriverZoneCreateInput {
  driver_name: string;
  zone_name: string;
  resolution: number;
  h3_cells: string[];
}

export interface DriverZoneUpdateInput {
  driver_name?: string;
  zone_name?: string;
  resolution?: number;
  h3_cells?: string[];
}
