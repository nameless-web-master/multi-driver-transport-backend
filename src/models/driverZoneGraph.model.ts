/**
 * Milestone 3 — Driver-Zone Graph types.
 *
 * The graph is built dynamically from existing transport zones (Milestone 1)
 * and zone connections (Milestone 2). Nodes are transport zones, edges are
 * the overlap/adjacency connections, and connected components are groups of
 * zones that can reach each other purely through those edges.
 *
 * This module deliberately holds no business logic — see
 * `services/driverZoneGraph.service.ts` for the actual build/component logic.
 *
 * IMPORTANT: Milestone 3 builds the *structure* only. It does not generate
 * delivery routes, pickup/drop-off paths, or driver assignments.
 */
import type { AdjacentCellPair, ConnectionType } from "./zoneConnection.model";

export type GraphNodeType = "transport_zone";
export type GraphZoneType = "h3" | "geofence";

export interface GraphPrimaryCoordinate {
  lat: number;
  lng: number;
}

export interface GraphNode {
  id: string;
  node_type: GraphNodeType;
  zone_id: number;
  zone_name: string;
  transport_id: number;
  transport_name: string;
  transport_method: string | null;
  zone_type: GraphZoneType;
  h3_cell_count: number;
  /** H3 resolution of `cells`. 0 when no cells. */
  resolution: number;
  /**
   * Full H3 cell list for the zone. Shipped on the node so the map view
   * can render the actual hexagons next to the abstract graph without a
   * second round trip (and for drivers who otherwise can't see other
   * drivers' zones via `/api/driver-zones`).
   */
  cells: string[];
  primary_coordinate: GraphPrimaryCoordinate | null;
  is_isolated: boolean;
  component_id: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  connection_type: ConnectionType;
  transfer_cells: string[];
  adjacent_cell_pairs: AdjacentCellPair[];
  transport_method_a: string | null;
  transport_method_b: string | null;
  /**
   * Reserved for future weighting (cost, distance, capacity). Milestone 3
   * keeps the graph unweighted and stamps every edge with 1 so downstream
   * milestones can swap in real values without changing the response shape.
   */
  weight: number;
  is_active: boolean;
}

export interface GraphComponent {
  id: string;
  node_ids: string[];
  edge_ids: string[];
  zone_count: number;
  transport_count: number;
  connection_count: number;
  transport_methods: string[];
  has_overlap: boolean;
  has_adjacency: boolean;
}

export interface GraphSummary {
  total_nodes: number;
  total_edges: number;
  connected_components: number;
  isolated_zones: number;
  overlap_edges: number;
  adjacent_edges: number;
  /** Total components including isolated singletons. */
  total_components_including_isolated: number;
  /** Wall-clock timestamp the snapshot was assembled. */
  generated_at: string;
}

export interface DriverZoneGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  components: GraphComponent[];
  isolated_nodes: GraphNode[];
  summary: GraphSummary;
}

export interface ZoneNeighborhood {
  zone: GraphNode;
  neighbors: GraphNode[];
  edges: GraphEdge[];
  degree: number;
}
