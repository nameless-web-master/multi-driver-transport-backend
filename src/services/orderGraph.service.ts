import { cellToLatLng, isValidCell, latLngToCell } from "h3-js";
import { pool } from "../database";
import type { AdjacentCellPair, ConnectionType } from "../models/zoneConnection.model";
import type { OrderGraph, OrderGraphEdge, OrderGraphNode, OrderGraphZoneNode } from "../models/orderGraph.model";
import { OrderError, getOrderById, type OrderContext } from "./order.service";
import { recalculateAllZoneConnections } from "./zoneConnection.service";
import { buildZoneScheduleFields, isZoneScheduleActive, parseScheduleFromRow } from "./zoneSchedule.service";

/**
 * Milestone 3 — Order-based transporter graph.
 *
 * Builds a sender → transporter-zones → receiver graph for ONE order:
 *   - Sender / Receiver are graph endpoints (their pickup/delivery H3).
 *   - Transporter zones are nodes.
 *   - Overlap / adjacency zone-connections (Milestone 2) are zone↔zone edges.
 *   - "pickup_coverage" edges link the sender to every zone covering the
 *     pickup cell; "delivery_coverage" edges link delivery-covering zones
 *     to the receiver.
 *
 * The service answers connectivity questions only:
 *   - Is there at least one connected chain sender → receiver?
 *   - Which zones are reachable from the sender?
 *   - Which transporters are isolated / unreachable for this order?
 *
 * It does NOT enumerate routes, choose a best path, or compute cost/ETA —
 * those are reserved for later milestones.
 */

const SENDER_ID = "sender";
const RECEIVER_ID = "receiver";

/** Cap on cells shipped per relevant zone so geofence zones don't melt the map. */
const MAX_CELLS_PER_ZONE = 4000;

interface ZoneMetaRow {
  id: number;
  owner_user_id: number;
  zone_name: string;
  resolution: number;
  transport_mode: string | null;
  transport_name: string;
  cell_count: number;
  zone_type: string | null;
  boundary: unknown;
}

interface ConnectionRow {
  id: number;
  zone_a_id: number;
  zone_b_id: number;
  connection_type: ConnectionType;
  transfer_cells: unknown;
  recommended_transfer_cell: string | null;
  adjacent_cell_pairs: unknown;
}

function zoneNodeId(zoneId: number): string {
  return `zone_${zoneId}`;
}

function parseCells(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parsePairs(raw: unknown): AdjacentCellPair[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (p): p is { from_cell: unknown; to_cell: unknown } =>
          Boolean(p && typeof p === "object" && "from_cell" in p && "to_cell" in p)
      )
      .map((p) => ({ from_cell: String(p.from_cell), to_cell: String(p.to_cell) }));
  }
  if (typeof raw === "string") {
    try {
      return parsePairs(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function sampleEvenly(arr: readonly string[], max: number): string[] {
  if (arr.length <= max) return [...arr];
  const out: string[] = [];
  const step = arr.length / max;
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

function centroidOfCells(cells: readonly string[]): { lat: number; lng: number } | null {
  if (cells.length === 0) return null;
  let latSum = 0;
  let lngSum = 0;
  let count = 0;
  const sampleSize = Math.min(cells.length, 200);
  for (let i = 0; i < sampleSize; i++) {
    if (!isValidCell(cells[i])) continue;
    try {
      const [lat, lng] = cellToLatLng(cells[i]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        latSum += lat;
        lngSum += lng;
        count++;
      }
    } catch {
      /* skip */
    }
  }
  if (count === 0) return null;
  return { lat: latSum / count, lng: lngSum / count };
}

/**
 * Find which available zones contain (lat, lng) by handing SQL the H3
 * candidate cells across all resolutions and leaning on the GIN index +
 * `?|` (jsonb has-any) operator. Mirrors the draft-preview approach.
 */
async function findCoveringZoneIds(lat: number | null, lng: number | null): Promise<Set<number>> {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return new Set();
  }
  const candidates: string[] = [];
  for (let r = 0; r <= 15; r++) {
    try {
      candidates.push(latLngToCell(lat, lng, r).toLowerCase());
    } catch {
      /* skip */
    }
  }
  if (candidates.length === 0) return new Set();
  const result = await pool.query(
    `SELECT z.id FROM driver_zones z
     WHERE z.available = TRUE AND z.h3_cells ?| $1::text[]`,
    [candidates]
  );
  return new Set(result.rows.map((r) => Number(r.id)));
}

async function loadZoneMeta(): Promise<ZoneMetaRow[]> {
  const result = await pool.query(
    `SELECT z.id, z.owner_user_id, z.zone_name, z.resolution, z.transport_mode,
            z.zone_type, z.boundary,
            z.operation_date, z.operation_start_date, z.operation_end_date,
            z.schedule_pattern, z.weekday_start, z.weekday_end,
            z.month_day_start, z.month_day_end,
            z.operating_start_time, z.operating_end_time,
            z.departure_time, z.arrival_time,
            jsonb_array_length(z.h3_cells) AS cell_count,
            COALESCE(u.full_name, '') AS transport_name
     FROM driver_zones z
     LEFT JOIN users u ON u.id = z.owner_user_id
     WHERE z.available = TRUE
     ORDER BY z.id`
  );
  const now = new Date();
  return result.rows
    .map((row) => ({
      id: Number(row.id),
      owner_user_id: Number(row.owner_user_id),
      zone_name: String(row.zone_name ?? ""),
      resolution: Number(row.resolution ?? 0),
      transport_mode: row.transport_mode == null ? null : String(row.transport_mode),
      transport_name: String(row.transport_name ?? ""),
      cell_count: Number(row.cell_count ?? 0),
      zone_type: row.zone_type == null ? null : String(row.zone_type),
      boundary: row.boundary,
    }))
    .filter((_, idx) => {
      const schedule = parseScheduleFromRow(result.rows[idx]);
      return isZoneScheduleActive(
        buildZoneScheduleFields({
          transport_mode: String(result.rows[idx].transport_mode ?? "land"),
          ...schedule,
        }),
        now
      );
    });
}

async function loadConnections(): Promise<ConnectionRow[]> {
  const result = await pool.query(
    `SELECT id, zone_a_id, zone_b_id, connection_type,
            transfer_cells, recommended_transfer_cell, adjacent_cell_pairs
     FROM zone_connections
     WHERE is_active = TRUE`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    zone_a_id: Number(row.zone_a_id),
    zone_b_id: Number(row.zone_b_id),
    connection_type: row.connection_type as ConnectionType,
    transfer_cells: row.transfer_cells,
    recommended_transfer_cell:
      row.recommended_transfer_cell == null ? null : String(row.recommended_transfer_cell),
    adjacent_cell_pairs: row.adjacent_cell_pairs,
  }));
}

async function loadCellsForZoneIds(ids: number[]): Promise<Map<number, string[]>> {
  if (ids.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, h3_cells FROM driver_zones WHERE id = ANY($1::int[])`,
    [ids]
  );
  const out = new Map<number, string[]>();
  for (const row of result.rows) {
    out.set(Number(row.id), sampleEvenly(parseCells(row.h3_cells), MAX_CELLS_PER_ZONE));
  }
  return out;
}

function zoneTypeOf(meta: ZoneMetaRow): "h3" | "geofence" {
  if (meta.zone_type === "geofence" || meta.zone_type === "h3") return meta.zone_type;
  return meta.boundary != null ? "geofence" : "h3";
}

/**
 * Build the order graph for `orderId` within the caller's access scope.
 */
export async function buildOrderGraph(
  ctx: OrderContext,
  orderId: number
): Promise<OrderGraph> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderError("Order not found", 404);

  const [zones, connections, pickupIds, deliveryIds] = await Promise.all([
    loadZoneMeta(),
    loadConnections(),
    findCoveringZoneIds(order.sender_lat, order.sender_lng),
    findCoveringZoneIds(order.destination_lat, order.destination_lng),
  ]);

  const zoneById = new Map(zones.map((z) => [z.id, z]));

  // Drop covering ids that aren't in the available set (paranoia).
  pickupIds.forEach((id) => {
    if (!zoneById.has(id)) pickupIds.delete(id);
  });
  deliveryIds.forEach((id) => {
    if (!zoneById.has(id)) deliveryIds.delete(id);
  });

  // Only keep connections whose endpoints are both available zones.
  const validConnections = connections.filter(
    (c) => zoneById.has(c.zone_a_id) && zoneById.has(c.zone_b_id)
  );

  // --- Build the undirected adjacency over the whole node set. ----------
  // Nodes: sender, receiver, and every available zone.
  const adjacency = new Map<string, string[]>();
  function link(a: string, b: string) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push(b);
    adjacency.get(b)!.push(a);
  }

  const edges: OrderGraphEdge[] = [];

  // sender → pickup-covering zones
  pickupIds.forEach((zoneId) => {
    const target = zoneNodeId(zoneId);
    link(SENDER_ID, target);
    edges.push({
      id: `pickup_${zoneId}`,
      source: SENDER_ID,
      target,
      edge_type: "pickup_coverage",
      transfer_cells: order.pickup_h3 ? [order.pickup_h3] : [],
      recommended_transfer_cell: order.pickup_h3 ?? null,
      adjacent_cell_pairs: [],
    });
  });

  // delivery-covering zones → receiver
  deliveryIds.forEach((zoneId) => {
    const source = zoneNodeId(zoneId);
    link(source, RECEIVER_ID);
    edges.push({
      id: `delivery_${zoneId}`,
      source,
      target: RECEIVER_ID,
      edge_type: "delivery_coverage",
      transfer_cells: order.delivery_h3 ? [order.delivery_h3] : [],
      recommended_transfer_cell: order.delivery_h3 ?? null,
      adjacent_cell_pairs: [],
    });
  });

  // zone ↔ zone (overlap / adjacency)
  for (const c of validConnections) {
    const a = zoneNodeId(c.zone_a_id);
    const b = zoneNodeId(c.zone_b_id);
    link(a, b);
    edges.push({
      id: `conn_${c.id}`,
      source: a,
      target: b,
      edge_type: c.connection_type,
      transfer_cells: parseCells(c.transfer_cells),
      recommended_transfer_cell: c.recommended_transfer_cell,
      adjacent_cell_pairs: parsePairs(c.adjacent_cell_pairs),
    });
  }

  // --- Reachability via BFS --------------------------------------------
  function bfs(start: string): Set<string> {
    const seen = new Set<string>();
    if (!adjacency.has(start)) {
      seen.add(start);
      return seen;
    }
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of adjacency.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  const reachableFromSender = bfs(SENDER_ID);
  const canReachReceiver = bfs(RECEIVER_ID);
  const hasCompleteConnection = reachableFromSender.has(RECEIVER_ID);

  // Zones that touch at least one edge (coverage or connection).
  const connectedZoneNodeIds = new Set<string>();
  for (const e of edges) {
    if (e.source.startsWith("zone_")) connectedZoneNodeIds.add(e.source);
    if (e.target.startsWith("zone_")) connectedZoneNodeIds.add(e.target);
  }

  // --- Decide which zones get their cells shipped (map view). ----------
  const surfacedForCells = new Set<number>();
  zones.forEach((z) => {
    const nodeId = zoneNodeId(z.id);
    if (
      pickupIds.has(z.id) ||
      deliveryIds.has(z.id) ||
      reachableFromSender.has(nodeId) ||
      canReachReceiver.has(nodeId)
    ) {
      surfacedForCells.add(z.id);
    }
  });
  const cellsByZone = await loadCellsForZoneIds(Array.from(surfacedForCells));

  // --- Build nodes ------------------------------------------------------
  const reachableZoneIds: number[] = [];
  const unreachableZoneIds: number[] = [];
  const isolatedZoneIds: number[] = [];

  const zoneNodes: OrderGraphZoneNode[] = zones.map((z) => {
    const nodeId = zoneNodeId(z.id);
    const cells = cellsByZone.get(z.id) ?? [];
    const isReachable = reachableFromSender.has(nodeId);
    const hasAnyEdge = connectedZoneNodeIds.has(nodeId);
    const isIsolated = !hasAnyEdge;
    if (isReachable) reachableZoneIds.push(z.id);
    else unreachableZoneIds.push(z.id);
    if (isIsolated) isolatedZoneIds.push(z.id);
    return {
      id: nodeId,
      node_type: "transport_zone",
      zone_id: z.id,
      transport_id: z.owner_user_id,
      transport_name: z.transport_name,
      zone_name: z.zone_name,
      zone_type: zoneTypeOf(z),
      transport_method: z.transport_mode,
      h3_cell_count: z.cell_count,
      resolution: z.resolution,
      cells,
      primary_coordinate: cells.length > 0 ? centroidOfCells(cells) : null,
      is_pickup_covering: pickupIds.has(z.id),
      is_delivery_covering: deliveryIds.has(z.id),
      is_reachable: isReachable,
      is_isolated: isIsolated,
    };
  });

  const senderCoord =
    order.sender_lat != null && order.sender_lng != null
      ? { lat: order.sender_lat, lng: order.sender_lng }
      : null;
  const receiverCoord =
    order.destination_lat != null && order.destination_lng != null
      ? { lat: order.destination_lat, lng: order.destination_lng }
      : null;

  const nodes: OrderGraphNode[] = [
    {
      id: SENDER_ID,
      node_type: "sender",
      label: order.source_name || order.sender_name || "Sender",
      h3: order.pickup_h3,
      primary_coordinate: senderCoord,
    },
    {
      id: RECEIVER_ID,
      node_type: "receiver",
      label: order.receiver_name || "Receiver",
      h3: order.delivery_h3,
      primary_coordinate: receiverCoord,
    },
    ...zoneNodes,
  ];

  const pickupCoveringZones = Array.from(pickupIds).sort((a, b) => a - b);
  const deliveryCoveringZones = Array.from(deliveryIds).sort((a, b) => a - b);

  const reachableTransportSet = new Set<number>();
  zoneNodes.forEach((z) => {
    if (z.is_reachable) reachableTransportSet.add(z.transport_id);
  });
  const pickupTransportSet = new Set<number>();
  pickupCoveringZones.forEach((id) => {
    const z = zoneById.get(id);
    if (z) pickupTransportSet.add(z.owner_user_id);
  });
  const deliveryTransportSet = new Set<number>();
  deliveryCoveringZones.forEach((id) => {
    const z = zoneById.get(id);
    if (z) deliveryTransportSet.add(z.owner_user_id);
  });

  return {
    order_id: order.id,
    pickup_h3: order.pickup_h3,
    delivery_h3: order.delivery_h3,
    nodes,
    edges,
    has_complete_connection: hasCompleteConnection,
    pickup_covering_zones: pickupCoveringZones,
    delivery_covering_zones: deliveryCoveringZones,
    reachable_zone_ids: reachableZoneIds.sort((a, b) => a - b),
    unreachable_zone_ids: unreachableZoneIds.sort((a, b) => a - b),
    isolated_zone_ids: isolatedZoneIds.sort((a, b) => a - b),
    summary: {
      total_nodes: nodes.length,
      total_edges: edges.length,
      pickup_covering_transporters: pickupTransportSet.size,
      delivery_covering_transporters: deliveryTransportSet.size,
      reachable_transporters: reachableTransportSet.size,
      unreachable_transporters: Math.max(
        0,
        new Set(zoneNodes.map((z) => z.transport_id)).size - reachableTransportSet.size
      ),
      has_complete_connection: hasCompleteConnection,
    },
  };
}

/**
 * Rebuild the order graph. The graph is computed on demand, so "build" is
 * `buildOrderGraph` plus an optional Milestone-2 connection recalculation
 * pass (so the order graph reflects the freshest zone overlaps).
 */
export async function rebuildOrderGraph(
  ctx: OrderContext,
  orderId: number,
  options: { recalculate_connections?: boolean } = {}
): Promise<OrderGraph> {
  if (options.recalculate_connections) {
    await recalculateAllZoneConnections();
  }
  return buildOrderGraph(ctx, orderId);
}

export async function getOrderGraphSummary(ctx: OrderContext, orderId: number) {
  const graph = await buildOrderGraph(ctx, orderId);
  return {
    order_id: graph.order_id,
    pickup_h3: graph.pickup_h3,
    delivery_h3: graph.delivery_h3,
    ...graph.summary,
  };
}
