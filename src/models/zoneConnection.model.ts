/**
 * Milestone 2 — Zone connection domain types.
 *
 * Two driver zones are "connected" when:
 *  - overlap:   their H3 cell sets intersect (shared coverage)
 *  - adjacent:  their cell sets don't intersect but at least one cell of A is
 *               a direct (1-ring) H3 neighbour of a cell of B
 *
 * Overlap is stronger and is preferred when both conditions hold.
 */

export const CONNECTION_TYPES = ["overlap", "adjacent"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export interface AdjacentCellPair {
  from_cell: string;
  to_cell: string;
}

export interface ZoneConnectionRow {
  id: number;
  zone_a_id: number;
  zone_b_id: number;
  transport_a_id: number;
  transport_b_id: number;
  connection_type: ConnectionType;
  transfer_cells: string[];
  adjacent_cell_pairs: AdjacentCellPair[] | null;
  transport_method_a: string | null;
  transport_method_b: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === "string" && (CONNECTION_TYPES as readonly string[]).includes(value);
}
