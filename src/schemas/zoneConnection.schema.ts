import { z } from "zod";
import {
  CONNECTION_TYPES,
  type AdjacentCellPair,
  type HubRole,
} from "../models/zoneConnection.model";

export const connectionTypeSchema = z.enum(CONNECTION_TYPES);

/** Optional filters supported by `GET /api/zone-connections`. */
export const listConnectionFiltersSchema = z.object({
  connection_type: connectionTypeSchema.optional(),
  transport_id: z.coerce.number().int().positive().optional(),
  zone_id: z.coerce.number().int().positive().optional(),
});
export type ListConnectionFilters = z.infer<typeof listConnectionFiltersSchema>;

export interface ZoneConnectionHub {
  name: string;
  lat: number;
  lng: number;
}

export interface ZoneConnectionPartySummary {
  id: number;
  zone_name: string;
  transport_id: number;
  transport_name: string;
  transport_method: string | null;
  cell_count: number;
  resolution: number;
  /**
   * Full H3 cell list for this zone. Embedded so the connection map can
   * always render both zones — drivers don't have visibility into other
   * drivers' zones via the regular zones API, so we ship the geometry as
   * part of the connection itself.
   */
  cells: string[];
  /** Air/sea route terminals. Null for land zones. */
  departure_hub: ZoneConnectionHub | null;
  arrival_hub: ZoneConnectionHub | null;
  departure_time: string | null;
  arrival_time: string | null;
}

export interface ZoneConnectionResponse {
  id: number;
  connection_type: "overlap" | "adjacent" | "hub";
  transfer_cells: string[];
  adjacent_cell_pairs: AdjacentCellPair[];
  /** The single recommended transfer cell (closest to the zone-centroid midpoint). */
  recommended_transfer_cell: string | null;
  transport_method_a: string | null;
  transport_method_b: string | null;
  /**
   * For `hub` connections: which terminal of the air/sea side anchors the
   * handoff. Null on land sides and for non-hub connections.
   */
  hub_role_a: HubRole | null;
  hub_role_b: HubRole | null;
  /** Counts surfaced for convenience so the UI doesn't have to recompute. */
  transfer_cell_count: number;
  adjacent_pair_count: number;
  zone_a: ZoneConnectionPartySummary;
  zone_b: ZoneConnectionPartySummary;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RecalcStats {
  total_connections: number;
  overlap_connections: number;
  adjacent_connections: number;
  hub_connections: number;
  zones_compared: number;
}
