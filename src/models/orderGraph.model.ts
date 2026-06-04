/**
 * Milestone 3 — Order-based transporter graph types.
 *
 * Unlike the global driver-zone graph (models/driverZoneGraph.model.ts),
 * this graph is built *for a single order*:
 *
 *   Sender node ──pickup_coverage──▶ transporter-zone nodes
 *   transporter-zone ──overlap/adjacent──▶ transporter-zone
 *   transporter-zone ──delivery_coverage──▶ Receiver node
 *
 * The service determines connectivity only (reachable / unreachable /
 * isolated). It deliberately does NOT enumerate routes, pick a best path,
 * or compute cost / ETA — those belong to later milestones.
 */
import type { AdjacentCellPair, ConnectionType } from "./zoneConnection.model";

export type OrderGraphNodeType = "sender" | "receiver" | "transport_zone";
export type OrderGraphZoneType = "h3" | "geofence";

export type OrderGraphEdgeType =
  | "pickup_coverage"
  | "delivery_coverage"
  | ConnectionType; // "overlap" | "adjacent"

export interface OrderGraphCoordinate {
  lat: number;
  lng: number;
}

export interface OrderGraphEndpointNode {
  id: "sender" | "receiver";
  node_type: "sender" | "receiver";
  label: string;
  h3: string | null;
  primary_coordinate: OrderGraphCoordinate | null;
}

export interface OrderGraphZoneNode {
  id: string; // `zone_<id>`
  node_type: "transport_zone";
  zone_id: number;
  transport_id: number;
  transport_name: string;
  zone_name: string;
  zone_type: OrderGraphZoneType;
  transport_method: string | null;
  h3_cell_count: number;
  resolution: number;
  cells: string[];
  primary_coordinate: OrderGraphCoordinate | null;
  is_pickup_covering: boolean;
  is_delivery_covering: boolean;
  /** Reachable from the sender through the zone graph. */
  is_reachable: boolean;
  /** Has no edges at all in this order's graph. */
  is_isolated: boolean;
}

export type OrderGraphNode = OrderGraphEndpointNode | OrderGraphZoneNode;

export interface OrderGraphEdge {
  id: string;
  source: string;
  target: string;
  edge_type: OrderGraphEdgeType;
  transfer_cells: string[];
  recommended_transfer_cell: string | null;
  adjacent_cell_pairs: AdjacentCellPair[];
}

export interface OrderGraphSummary {
  total_nodes: number;
  total_edges: number;
  pickup_covering_transporters: number;
  delivery_covering_transporters: number;
  reachable_transporters: number;
  unreachable_transporters: number;
  has_complete_connection: boolean;
}

export interface OrderGraph {
  order_id: number;
  pickup_h3: string | null;
  delivery_h3: string | null;
  nodes: OrderGraphNode[];
  edges: OrderGraphEdge[];
  has_complete_connection: boolean;
  pickup_covering_zones: number[];
  delivery_covering_zones: number[];
  reachable_zone_ids: number[];
  unreachable_zone_ids: number[];
  isolated_zone_ids: number[];
  summary: OrderGraphSummary;
}
