import { cellToLatLng, isValidCell } from "h3-js";
import { pool } from "../database";
import type {
  DriverZoneGraph,
  GraphComponent,
  GraphEdge,
  GraphNode,
  GraphSummary,
  GraphZoneType,
  ZoneNeighborhood,
} from "../models/driverZoneGraph.model";
import type {
  AdjacentCellPair,
  ConnectionType,
} from "../models/zoneConnection.model";
import type { UserRole } from "../models/userRole.model";
import { recalculateAllZoneConnections } from "./zoneConnection.service";

/**
 * Milestone 3 — Driver-Zone Graph service.
 *
 * Reads existing transport zones and zone connections (Milestones 1 + 2)
 * and converts them into a graph/network model:
 *
 *   Node = transport zone
 *   Edge = zone connection (overlap / adjacency)
 *
 * The service detects connected components, isolated nodes, and a few
 * summary stats. It deliberately does NOT compute paths, routes, or
 * driver assignments — those are reserved for future milestones.
 *
 * The graph is computed on demand from the underlying tables; there is no
 * persistent graph_snapshots table. Caching is up to the API layer.
 */

// --------------------------------------------------------------------------
// Access scope
// --------------------------------------------------------------------------

export interface GraphAccess {
  userId: number;
  role: UserRole;
}

/**
 * Admins see the full graph. Transport participants (drivers) see a
 * neighbourhood graph — their own zones plus any zone that connects to
 * them — so they can understand who they hand off to without leaking
 * unrelated transport companies' coverage. Senders/Receivers consume the
 * graph read-only at full scope (same as the zone-connections list).
 */
function isPrivilegedRole(role: UserRole): boolean {
  return role === "admin" || role === "sender" || role === "receiver";
}

// --------------------------------------------------------------------------
// Database row shapes
// --------------------------------------------------------------------------

interface ZoneRow {
  id: number;
  owner_user_id: number;
  zone_name: string;
  resolution: number;
  h3_cells: unknown;
  transport_mode: string | null;
  boundary: unknown;
  transport_name: string;
  departure_hub_name: string | null;
  departure_hub_lat: number | null;
  departure_hub_lng: number | null;
  arrival_hub_name: string | null;
  arrival_hub_lat: number | null;
  arrival_hub_lng: number | null;
  departure_time: string | null;
  arrival_time: string | null;
}

interface ConnectionRow {
  id: number;
  zone_a_id: number;
  zone_b_id: number;
  transport_a_id: number;
  transport_b_id: number;
  connection_type: ConnectionType;
  transfer_cells: unknown;
  adjacent_cell_pairs: unknown;
  recommended_transfer_cell: string | null;
  transport_method_a: string | null;
  transport_method_b: string | null;
  is_active: boolean;
}

function parseCellArray(raw: unknown): string[] {
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

function parseAdjacentPairs(raw: unknown): AdjacentCellPair[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (p): p is { from_cell: unknown; to_cell: unknown } =>
          !!p && typeof p === "object" && "from_cell" in p && "to_cell" in p
      )
      .map((p) => ({
        from_cell: String(p.from_cell),
        to_cell: String(p.to_cell),
      }));
  }
  if (typeof raw === "string") {
    try {
      return parseAdjacentPairs(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function parseBoundary(raw: unknown): boolean {
  if (!raw) return false;
  if (Array.isArray(raw)) return raw.length >= 3;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length >= 3;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Pick a representative coordinate for the zone — the centroid of all
 * H3 cells. Falls back to the first cell or null when no valid cells
 * exist. This is what the front-end uses to render the node-link layout
 * and to position the "view on map" link.
 */
function primaryCoordinateFor(cells: string[]): { lat: number; lng: number } | null {
  if (cells.length === 0) return null;
  let latSum = 0;
  let lngSum = 0;
  let count = 0;
  // Cap the sample so a 100k-cell zone doesn't sit here doing trig.
  const sampleSize = Math.min(cells.length, 500);
  for (let i = 0; i < sampleSize; i++) {
    const cell = cells[i];
    if (!isValidCell(cell)) continue;
    try {
      const [lat, lng] = cellToLatLng(cell);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        latSum += lat;
        lngSum += lng;
        count++;
      }
    } catch {
      /* skip invalid cell */
    }
  }
  if (count === 0) return null;
  return { lat: latSum / count, lng: lngSum / count };
}

// --------------------------------------------------------------------------
// Pure graph helpers (exported for tests / future reuse)
// --------------------------------------------------------------------------

function zoneNodeId(zoneId: number): string {
  return `zone_${zoneId}`;
}

function edgeIdFromConnection(connectionId: number): string {
  return `edge_${connectionId}`;
}

function componentIdFor(index: number): string {
  return `component_${index + 1}`;
}

/**
 * Build the GraphNode for a single transport zone. Component id is filled
 * in later by `detectConnectedComponents`; until then the node carries the
 * placeholder "component_unassigned" so the field is always populated.
 */
function hubTerminal(
  name: string | null,
  lat: number | null,
  lng: number | null
): { name: string; lat: number; lng: number } | null {
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  return { name: (name ?? "").trim(), lat: Number(lat), lng: Number(lng) };
}

export function buildNode(row: ZoneRow): GraphNode {
  const cells = parseCellArray(row.h3_cells);
  const hasBoundary = parseBoundary(row.boundary);
  const zoneType: GraphZoneType = hasBoundary ? "geofence" : "h3";
  const departureHub = hubTerminal(row.departure_hub_name, row.departure_hub_lat, row.departure_hub_lng);
  const arrivalHub = hubTerminal(row.arrival_hub_name, row.arrival_hub_lat, row.arrival_hub_lng);
  return {
    id: zoneNodeId(row.id),
    node_type: "transport_zone",
    zone_id: row.id,
    zone_name: row.zone_name,
    transport_id: row.owner_user_id,
    transport_name: row.transport_name || "",
    transport_method: row.transport_mode,
    zone_type: zoneType,
    h3_cell_count: cells.length,
    resolution: Number.isFinite(Number(row.resolution)) ? Number(row.resolution) : 0,
    cells,
    primary_coordinate: departureHub ?? primaryCoordinateFor(cells),
    departure_hub: departureHub,
    arrival_hub: arrivalHub,
    departure_time: row.departure_time == null ? null : String(row.departure_time),
    arrival_time: row.arrival_time == null ? null : String(row.arrival_time),
    is_isolated: false,
    component_id: "component_unassigned",
  };
}

export function buildNodes(rows: ZoneRow[]): GraphNode[] {
  return rows.map(buildNode);
}

/**
 * Convert each persisted zone_connection row into a graph edge. The edge
 * `weight` is always 1 in Milestone 3 — future milestones will swap it for
 * cost/distance/capacity without changing the response shape.
 */
export function buildEdge(row: ConnectionRow): GraphEdge {
  return {
    id: edgeIdFromConnection(row.id),
    source: zoneNodeId(row.zone_a_id),
    target: zoneNodeId(row.zone_b_id),
    connection_type: row.connection_type,
    transfer_cells: parseCellArray(row.transfer_cells),
    adjacent_cell_pairs: parseAdjacentPairs(row.adjacent_cell_pairs),
    recommended_transfer_cell: row.recommended_transfer_cell ?? null,
    transport_method_a: row.transport_method_a,
    transport_method_b: row.transport_method_b,
    weight: 1,
    is_active: Boolean(row.is_active),
  };
}

export function buildEdges(rows: ConnectionRow[]): GraphEdge[] {
  return rows.map(buildEdge);
}

/**
 * Count the number of edges that touch a node. We treat the graph as
 * undirected (an A→B edge contributes 1 to both A and B).
 */
export function getNodeDegree(nodeId: string, edges: readonly GraphEdge[]): number {
  let degree = 0;
  for (const edge of edges) {
    if (edge.source === nodeId || edge.target === nodeId) degree++;
  }
  return degree;
}

/**
 * Group nodes into connected components via union-find. Returns a Map
 * from node id → component id. Isolated nodes also get their own
 * single-node component so component_id is never empty.
 *
 * The component naming is deterministic: components are ordered by the
 * smallest zone_id they contain, then numbered "component_1", "component_2",
 * etc. Isolated nodes are emitted *after* multi-node components for stable
 * IDs across rebuilds.
 */
export function detectConnectedComponents(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): {
  components: GraphComponent[];
  componentByNodeId: Map<string, string>;
} {
  const parent = new Map<string, string>();
  for (const node of nodes) parent.set(node.id, node.id);

  function find(x: string): string {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, parent.get(next)!);
      cur = parent.get(cur)!;
    }
    return cur;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const edge of edges) {
    if (parent.has(edge.source) && parent.has(edge.target)) {
      union(edge.source, edge.target);
    }
  }

  // Bucket nodes + edges by their root.
  const byRoot = new Map<
    string,
    {
      nodes: GraphNode[];
      edges: GraphEdge[];
      smallestZoneId: number;
    }
  >();
  for (const node of nodes) {
    const root = find(node.id);
    const bucket = byRoot.get(root);
    if (bucket) {
      bucket.nodes.push(node);
      if (node.zone_id < bucket.smallestZoneId) bucket.smallestZoneId = node.zone_id;
    } else {
      byRoot.set(root, { nodes: [node], edges: [], smallestZoneId: node.zone_id });
    }
  }
  for (const edge of edges) {
    const root = parent.has(edge.source) ? find(edge.source) : null;
    if (!root) continue;
    const bucket = byRoot.get(root);
    if (bucket) bucket.edges.push(edge);
  }

  // Sort: multi-node components first (in zone-id order), then singletons
  // (also in zone-id order). Makes the IDs we emit stable + readable.
  const buckets = Array.from(byRoot.values()).sort((a, b) => {
    const multiA = a.nodes.length > 1 ? 0 : 1;
    const multiB = b.nodes.length > 1 ? 0 : 1;
    if (multiA !== multiB) return multiA - multiB;
    return a.smallestZoneId - b.smallestZoneId;
  });

  const components: GraphComponent[] = [];
  const componentByNodeId = new Map<string, string>();

  buckets.forEach((bucket, idx) => {
    const compId = componentIdFor(idx);
    const transports = new Set<number>();
    const methods = new Set<string>();
    let hasOverlap = false;
    let hasAdjacency = false;

    for (const node of bucket.nodes) {
      componentByNodeId.set(node.id, compId);
      transports.add(node.transport_id);
      if (node.transport_method) methods.add(node.transport_method);
    }
    for (const edge of bucket.edges) {
      if (edge.connection_type === "overlap") hasOverlap = true;
      else if (edge.connection_type === "adjacent") hasAdjacency = true;
    }

    components.push({
      id: compId,
      node_ids: bucket.nodes.map((n) => n.id),
      edge_ids: bucket.edges.map((e) => e.id),
      zone_count: bucket.nodes.length,
      transport_count: transports.size,
      connection_count: bucket.edges.length,
      transport_methods: Array.from(methods).sort(),
      has_overlap: hasOverlap,
      has_adjacency: hasAdjacency,
    });
  });

  return { components, componentByNodeId };
}

/**
 * Single-node components (no edges) are surfaced separately so the UI can
 * highlight "isolated zones" in their own panel.
 */
export function detectIsolatedNodes(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): GraphNode[] {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  return nodes.filter((n) => !connected.has(n.id));
}

export function getGraphSummary(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  components: readonly GraphComponent[],
  isolatedNodes: readonly GraphNode[]
): GraphSummary {
  const overlapEdges = edges.filter((e) => e.connection_type === "overlap").length;
  const adjacentEdges = edges.filter((e) => e.connection_type === "adjacent").length;
  const hubEdges = edges.filter((e) => e.connection_type === "hub").length;
  // "Connected components" in the spec's summary means *multi-node* groups —
  // a single isolated zone is reported in `isolated_zones` instead. We also
  // surface a total count (including singletons) for completeness.
  const multiComponents = components.filter((c) => c.zone_count > 1).length;
  return {
    total_nodes: nodes.length,
    total_edges: edges.length,
    connected_components: multiComponents,
    isolated_zones: isolatedNodes.length,
    overlap_edges: overlapEdges,
    adjacent_edges: adjacentEdges,
    hub_edges: hubEdges,
    total_components_including_isolated: components.length,
    generated_at: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------
// SQL helpers
// --------------------------------------------------------------------------

const ZONE_SELECT = `
  SELECT z.id, z.owner_user_id, z.zone_name, z.resolution, z.h3_cells,
         z.transport_mode, z.boundary,
         z.departure_hub_name, z.departure_hub_lat, z.departure_hub_lng,
         z.arrival_hub_name, z.arrival_hub_lat, z.arrival_hub_lng,
         z.departure_time, z.arrival_time,
         COALESCE(u.full_name, '') AS transport_name
  FROM driver_zones z
  LEFT JOIN users u ON u.id = z.owner_user_id
  WHERE z.available = TRUE
`;

const CONNECTION_SELECT = `
  SELECT c.id, c.zone_a_id, c.zone_b_id, c.transport_a_id, c.transport_b_id,
         c.connection_type, c.transfer_cells, c.adjacent_cell_pairs,
         c.recommended_transfer_cell,
         c.transport_method_a, c.transport_method_b, c.is_active
  FROM zone_connections c
  WHERE c.is_active = TRUE
`;

/**
 * Minimal shape shared by `pg`'s `Pool` and `PoolClient`. Letting the scope
 * helpers accept either means `buildGraph` can run its two reads on a single
 * acquired client (one connection, sequential) instead of forcing the pool to
 * open two fresh connections at once — which can blow past
 * `connectionTimeoutMillis` against a cold/slow remote DB.
 */
type Queryable = Pick<typeof pool, "query">;

async function fetchZonesForScope(
  ctx: GraphAccess,
  db: Queryable = pool
): Promise<ZoneRow[]> {
  // Drivers see their own zones plus any zone that is connected to one
  // of theirs. Privileged roles see everything.
  if (isPrivilegedRole(ctx.role)) {
    const result = await db.query(`${ZONE_SELECT} ORDER BY z.id`);
    return result.rows as ZoneRow[];
  }
  if (ctx.role === "driver") {
    const result = await db.query(
      `${ZONE_SELECT}
         AND (
           z.owner_user_id = $1
           OR z.id IN (
             SELECT zone_b_id FROM zone_connections
               WHERE is_active = TRUE AND transport_a_id = $1
             UNION
             SELECT zone_a_id FROM zone_connections
               WHERE is_active = TRUE AND transport_b_id = $1
           )
         )
       ORDER BY z.id`,
      [ctx.userId]
    );
    return result.rows as ZoneRow[];
  }
  // Fallback (unknown roles): no data.
  return [];
}

async function fetchConnectionsForScope(
  ctx: GraphAccess,
  db: Queryable = pool
): Promise<ConnectionRow[]> {
  if (isPrivilegedRole(ctx.role)) {
    const result = await db.query(`${CONNECTION_SELECT} ORDER BY c.id`);
    return result.rows as ConnectionRow[];
  }
  if (ctx.role === "driver") {
    const result = await db.query(
      `${CONNECTION_SELECT}
         AND (c.transport_a_id = $1 OR c.transport_b_id = $1)
       ORDER BY c.id`,
      [ctx.userId]
    );
    return result.rows as ConnectionRow[];
  }
  return [];
}

// --------------------------------------------------------------------------
// Public service API
// --------------------------------------------------------------------------

/**
 * Build the complete graph response for the supplied access context.
 *
 *   - Fetch in-scope zones + connections
 *   - Convert to graph nodes + edges
 *   - Detect connected components + isolated nodes
 *   - Stamp component_id / is_isolated onto every node
 *   - Compute summary
 */
export async function buildGraph(ctx: GraphAccess): Promise<DriverZoneGraph> {
  // Run both reads on a single pooled client, one after the other. This needs
  // exactly one connection (vs. two concurrent ones with Promise.all), which
  // avoids "timeout exceeded when trying to connect" when the remote DB is
  // cold/slow and opening a second simultaneous connection would stall.
  const client = await pool.connect();
  let zoneRows: ZoneRow[];
  let connectionRows: ConnectionRow[];
  try {
    zoneRows = await fetchZonesForScope(ctx, client);
    connectionRows = await fetchConnectionsForScope(ctx, client);
  } finally {
    client.release();
  }

  const nodes = buildNodes(zoneRows);
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  // For driver scope, a connection row could in theory reference a zone the
  // driver doesn't have access to in `fetchZonesForScope` (shouldn't happen
  // given how we scope zones, but stay defensive). Filter such edges out so
  // the graph never has dangling endpoints.
  const edges = buildEdges(connectionRows).filter(
    (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target)
  );

  const { components, componentByNodeId } = detectConnectedComponents(nodes, edges);
  const isolatedNodes = detectIsolatedNodes(nodes, edges);
  const isolatedIds = new Set(isolatedNodes.map((n) => n.id));

  for (const node of nodes) {
    node.component_id = componentByNodeId.get(node.id) ?? "component_unassigned";
    node.is_isolated = isolatedIds.has(node.id);
  }

  return {
    nodes,
    edges,
    components,
    isolated_nodes: isolatedNodes,
    summary: getGraphSummary(nodes, edges, components, isolatedNodes),
  };
}

/**
 * Rebuild the graph. Since the graph is computed on demand from the live
 * zone + connection tables, "rebuild" is essentially `buildGraph` plus an
 * optional Milestone 2 recalculation pass.
 *
 * `recalculate_connections=true` is the convenience path behind the
 * dashboard's "Recalculate Connections & Rebuild Graph" button — it runs
 * the full M2 graph recompute before assembling the M3 view so the UI can
 * be sure the network is fresh.
 */
export async function rebuildGraph(
  ctx: GraphAccess,
  options: { recalculate_connections?: boolean } = {}
): Promise<DriverZoneGraph> {
  if (options.recalculate_connections) {
    // Only admins/drivers can trigger the M2 recalc; the calling route
    // enforces that. The graph build itself still respects the caller's
    // visibility scope.
    await recalculateAllZoneConnections();
  }
  return buildGraph(ctx);
}

export async function getGraphSummaryForCtx(ctx: GraphAccess): Promise<GraphSummary> {
  const graph = await buildGraph(ctx);
  return graph.summary;
}

export async function listComponents(ctx: GraphAccess): Promise<GraphComponent[]> {
  const graph = await buildGraph(ctx);
  return graph.components;
}

/**
 * Return one component with its full node + edge payload embedded — the
 * UI uses this to render the "view component" detail drawer without
 * having to look up nodes/edges separately.
 */
export async function getComponentById(
  ctx: GraphAccess,
  componentId: string
): Promise<{
  component: GraphComponent;
  nodes: GraphNode[];
  edges: GraphEdge[];
} | null> {
  const graph = await buildGraph(ctx);
  const component = graph.components.find((c) => c.id === componentId);
  if (!component) return null;
  const nodeIds = new Set(component.node_ids);
  const edgeIds = new Set(component.edge_ids);
  const nodes = graph.nodes.filter((n) => nodeIds.has(n.id));
  const edges = graph.edges.filter((e) => edgeIds.has(e.id));
  return { component, nodes, edges };
}

export async function listIsolatedZones(ctx: GraphAccess): Promise<GraphNode[]> {
  const graph = await buildGraph(ctx);
  return graph.isolated_nodes;
}

/**
 * Return the zone, its direct neighbours, and the connecting edges. The
 * front-end uses this to render the "1-hop view" drawer when a node is
 * selected — without having to fetch the whole graph again for a single
 * inspection.
 */
export async function getZoneGraphNeighborhood(
  ctx: GraphAccess,
  zoneId: number
): Promise<ZoneNeighborhood | null> {
  const graph = await buildGraph(ctx);
  const target = graph.nodes.find((n) => n.zone_id === zoneId);
  if (!target) return null;

  const edges = graph.edges.filter(
    (e) => e.source === target.id || e.target === target.id
  );
  const neighborIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source !== target.id) neighborIds.add(edge.source);
    if (edge.target !== target.id) neighborIds.add(edge.target);
  }
  const neighbors = graph.nodes.filter((n) => neighborIds.has(n.id));

  return {
    zone: target,
    neighbors,
    edges,
    degree: edges.length,
  };
}

export async function getNodeDegreeForZone(
  ctx: GraphAccess,
  zoneId: number
): Promise<{ zone_id: number; node_id: string; degree: number } | null> {
  const neighborhood = await getZoneGraphNeighborhood(ctx, zoneId);
  if (!neighborhood) return null;
  return {
    zone_id: zoneId,
    node_id: neighborhood.zone.id,
    degree: neighborhood.degree,
  };
}
