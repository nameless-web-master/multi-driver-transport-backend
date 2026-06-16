import {
  cellToChildren,
  cellToLatLng,
  cellToParent,
  getResolution,
  gridDisk,
  isValidCell,
  latLngToCell,
} from "h3-js";
import { pool } from "../database";
import type { PoolClient } from "pg";
import type {
  AdjacentCellPair,
  ConnectionType,
  HubRole,
  ZoneConnectionRow,
} from "../models/zoneConnection.model";
import type { UserRole } from "../models/userRole.model";
import type {
  ListConnectionFilters,
  RecalcStats,
  ZoneConnectionResponse,
} from "../schemas/zoneConnection.schema";

/**
 * Milestone 2 — Zone connection service.
 *
 * Responsibilities:
 *  - Pure H3 helpers (normalize / overlap / adjacency / detect)
 *  - Persistence (recalculate, list, get, delete)
 *  - Hook callable from driver-zone CRUD to keep the graph in sync
 *
 * Same-owner connections are intentionally INCLUDED — a driver may carve
 * up their region into multiple touching zones, and visualising those
 * boundaries is still useful. Filtering can happen in the UI.
 */

// --------------------------------------------------------------------------
// Pure H3 helpers
// --------------------------------------------------------------------------

/**
 * Validate, deduplicate, and lowercase a list of H3 indexes. Returns the
 * canonical cell set we'll compare against — invalid/blank inputs are
 * silently dropped (callers that need stricter validation should use
 * `sanitizeCells` from `h3_service`).
 */
export function normalizeCells(cells: readonly string[] | undefined | null): string[] {
  if (!cells) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of cells) {
    if (typeof raw !== "string") continue;
    const c = raw.trim().toLowerCase();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (isValidCell(c)) out.push(c);
  }
  return out;
}

/** Returns the intersection of two H3 cell sets. */
export function getOverlapCells(a: readonly string[], b: readonly string[]): string[] {
  const setA = new Set(a);
  const out: string[] = [];
  for (const cell of b) {
    if (setA.has(cell)) out.push(cell);
  }
  return out;
}

/**
 * For each cell in `a`, ask H3 for its 6 ring-1 neighbours and record any
 * that exist in `b`. Pairs are deduplicated and represented in `(from, to)`
 * form where `from` lives in zone A and `to` lives in zone B.
 *
 * H3 neighbours only align across cells of the same resolution; zones at
 * different resolutions will naturally not produce any pairs.
 */
export function getAdjacentCellPairs(
  a: readonly string[],
  b: readonly string[]
): AdjacentCellPair[] {
  const setB = new Set(b);
  const pairs: AdjacentCellPair[] = [];
  const seen = new Set<string>();
  for (const cellA of a) {
    let ring: string[];
    try {
      ring = gridDisk(cellA, 1);
    } catch {
      continue;
    }
    for (const neighbour of ring) {
      if (neighbour === cellA) continue;
      if (!setB.has(neighbour)) continue;
      const key = `${cellA}|${neighbour}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ from_cell: cellA, to_cell: neighbour });
    }
  }
  return pairs;
}

export interface DetectedConnection {
  connection_type: ConnectionType;
  transfer_cells: string[];
  adjacent_cell_pairs: AdjacentCellPair[];
  /**
   * Milestone 2 (updated scope): the single transfer cell the system
   * recommends when several candidates exist. Chosen as the candidate cell
   * closest to the midpoint between the two zones' centroids. Null only
   * when no candidate cell could be resolved.
   */
  recommended_transfer_cell: string | null;
}

interface Coord {
  lat: number;
  lng: number;
}

/** Centroid of an H3 cell set (sampled, cheap). Null when empty/invalid. */
function centroidOfCells(cells: readonly string[]): Coord | null {
  if (cells.length === 0) return null;
  let latSum = 0;
  let lngSum = 0;
  let count = 0;
  const sampleSize = Math.min(cells.length, 500);
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
 * From a list of candidate cells, pick the one whose center is closest to
 * `target`. Falls back to the first candidate when the target is unknown
 * (deterministic) — exactly the simpler rule the spec allows. Plain squared
 * lat/lng distance is sufficient for choosing a representative cell.
 */
function pickClosestCell(candidates: readonly string[], target: Coord | null): string | null {
  if (candidates.length === 0) return null;
  if (!target) return candidates[0];
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cell of candidates) {
    if (!isValidCell(cell)) continue;
    let center: [number, number];
    try {
      center = cellToLatLng(cell);
    } catch {
      continue;
    }
    const dLat = center[0] - target.lat;
    const dLng = center[1] - target.lng;
    const dist = dLat * dLat + dLng * dLng;
    if (dist < bestDist) {
      bestDist = dist;
      best = cell;
    }
  }
  return best ?? candidates[0];
}

function midpoint(a: Coord | null, b: Coord | null): Coord | null {
  if (!a || !b) return a ?? b ?? null;
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

/**
 * Upper bound on the number of cells we'll generate when expanding a coarse
 * zone to a finer resolution. Each H3 resolution step multiplies cell count
 * by ~7, so a 3-level gap on a 100-cell zone gives ~34k cells (fine), a
 * 5-level gap gives ~1.7M (not fine). Beyond the cap we bail with a warning
 * rather than blow up memory.
 */
const MAX_EXPANDED_CELLS_PER_ZONE = 100_000;

/**
 * Promote a cell set to `targetRes`. Cells already at or finer than the
 * target are passed through; coarser cells are replaced by their children.
 * Returns null if the resulting set would exceed `MAX_EXPANDED_CELLS_PER_ZONE`.
 */
function expandToResolution(
  cells: readonly string[],
  targetRes: number
): string[] | null {
  const out: string[] = [];
  for (const cell of cells) {
    let r: number;
    try {
      r = getResolution(cell);
    } catch {
      continue;
    }
    if (r >= targetRes) {
      // Already at or finer than target — keep as-is. The `r > targetRes`
      // case shouldn't occur in practice (callers pick targetRes = max of
      // the two zones) but we handle it defensively.
      out.push(cell);
    } else {
      let children: string[];
      try {
        children = cellToChildren(cell, targetRes);
      } catch {
        continue;
      }
      for (const child of children) {
        out.push(child);
        if (out.length > MAX_EXPANDED_CELLS_PER_ZONE) return null;
      }
    }
  }
  return out;
}

/**
 * Cross-resolution overlap by mapping the FINER zone's cells *up* to the
 * coarse resolution (one `cellToParent` per fine cell) and keeping those whose
 * parent is one of the coarse zone's cells.
 *
 * This replaces the old "expand the coarse zone *down* to children" approach
 * for overlap detection. Child expansion multiplies the cell count by ~7 per
 * resolution level, so a large gap (e.g. a big res-4 zone vs a res-9 zone)
 * blew past the expansion cap and silently reported "no overlap" — which is
 * exactly why a zone fully contained inside a much coarser zone (B ⊂ A) got
 * no connection. Mapping up is O(fine cells) and gap-proof, so containment is
 * always detected regardless of how far apart the two resolutions are.
 *
 * Returns the matching *fine* cells (real cells sitting inside the coarse
 * zone), which make natural transfer cells for the handoff.
 */
function getCrossResOverlapCells(
  coarseCells: readonly string[],
  fineCells: readonly string[],
  coarseRes: number
): string[] {
  const coarseSet = new Set(coarseCells);
  const out: string[] = [];
  for (const cell of fineCells) {
    let parent: string;
    try {
      parent = cellToParent(cell, coarseRes);
    } catch {
      continue;
    }
    if (coarseSet.has(parent)) out.push(cell);
  }
  return out;
}

/**
 * Build an "adjacent" connection result from detected touching cell pairs, or
 * null when there are none. Extracted so same-resolution and cross-resolution
 * paths share identical adjacency handling.
 */
function buildAdjacencyConnection(
  pairs: AdjacentCellPair[],
  mid: Coord | null
): DetectedConnection | null {
  if (pairs.length === 0) return null;

  // Representative transfer cells = unique "from" cells (capped) so adjacency
  // rows have something quick to show in the summary chips without needing the
  // full adjacent_cell_pairs payload.
  const reps: string[] = [];
  const repSeen = new Set<string>();
  for (const p of pairs) {
    if (repSeen.has(p.from_cell)) continue;
    repSeen.add(p.from_cell);
    reps.push(p.from_cell);
    if (reps.length >= 16) break;
  }
  // Adjacency: pick the touching pair whose midpoint is closest to the overall
  // midpoint, and recommend that pair's boundary cell (from_cell).
  let recommended: string | null = reps[0] ?? null;
  if (mid) {
    let bestDist = Infinity;
    for (const p of pairs) {
      if (!isValidCell(p.from_cell) || !isValidCell(p.to_cell)) continue;
      let cf: [number, number];
      let ct: [number, number];
      try {
        cf = cellToLatLng(p.from_cell);
        ct = cellToLatLng(p.to_cell);
      } catch {
        continue;
      }
      const pmLat = (cf[0] + ct[0]) / 2;
      const pmLng = (cf[1] + ct[1]) / 2;
      const dist = (pmLat - mid.lat) ** 2 + (pmLng - mid.lng) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        recommended = p.from_cell;
      }
    }
  }
  return {
    connection_type: "adjacent",
    transfer_cells: reps,
    adjacent_cell_pairs: pairs,
    recommended_transfer_cell: recommended,
  };
}

/**
 * Internal: detect overlap/adjacency between two cell sets, accounting for
 * possibly-different resolutions.
 *
 * Overlap (including full containment) is resolution-agnostic: when the two
 * sides differ we map the *finer* zone's cells up to the coarse resolution
 * and keep those whose parent is a coarse cell. This is O(fine cells) and
 * works no matter how large the resolution gap is — fixing the previous bug
 * where a zone fully inside a much coarser zone (B ⊂ A) produced no
 * connection because expanding the coarse zone to children overflowed the cap.
 *
 * Adjacency (zones that merely touch, with no shared area) still relies on
 * a bounded child-expansion when resolutions differ; for very large gaps that
 * safely yields no adjacency, which is acceptable since huge-gap adjacency is
 * not meaningful and any containment is already handled by the overlap check.
 *
 * Resolutions are passed in (not derived) so the O(N²) recalc loop doesn't
 * re-derive them per pair.
 */
function detectBetweenCells(
  a: readonly string[],
  b: readonly string[],
  aRes: number,
  bRes: number
): DetectedConnection | null {
  if (a.length === 0 || b.length === 0) return null;

  // Same resolution: exact cell-string overlap, then neighbour adjacency.
  if (aRes === bRes) {
    const mid = midpoint(centroidOfCells(a), centroidOfCells(b));
    const overlap = getOverlapCells(a, b);
    if (overlap.length > 0) {
      return {
        connection_type: "overlap",
        transfer_cells: overlap,
        adjacent_cell_pairs: [],
        recommended_transfer_cell: pickClosestCell(overlap, mid),
      };
    }
    return buildAdjacencyConnection(getAdjacentCellPairs(a, b), mid);
  }

  // Different resolutions: detect overlap/containment by mapping the finer
  // zone up to the coarse resolution (gap-proof), not by expanding the coarse
  // zone down to children (explodes on large gaps).
  const coarse = aRes < bRes ? a : b;
  const fine = aRes < bRes ? b : a;
  const coarseRes = Math.min(aRes, bRes);
  const mid = midpoint(centroidOfCells(a), centroidOfCells(b));

  const overlap = getCrossResOverlapCells(coarse, fine, coarseRes);
  if (overlap.length > 0) {
    return {
      connection_type: "overlap",
      transfer_cells: overlap,
      adjacent_cell_pairs: [],
      recommended_transfer_cell: pickClosestCell(overlap, mid),
    };
  }

  // No shared area — fall back to a bounded expansion to catch genuine
  // adjacency between modestly different resolutions. Large gaps return null
  // (no adjacency), which is fine: containment is already handled above.
  const targetRes = Math.max(aRes, bRes);
  const aFine = aRes < targetRes ? expandToResolution(a, targetRes) : a;
  const bFine = bRes < targetRes ? expandToResolution(b, targetRes) : b;
  if (aFine === null || bFine === null) return null;

  return buildAdjacencyConnection(getAdjacentCellPairs(aFine, bFine), mid);
}

/**
 * Compare two zones and return the strongest connection, or `null` if
 * they are unrelated. Overlap > adjacency. Public API normalizes its
 * inputs defensively so external callers can pass raw arrays straight
 * from request bodies and is resolution-aware (auto-promotes the coarser
 * side so res-6 and res-7 zones that cover the same area still match).
 */
export function detectConnection(
  zoneACells: readonly string[],
  zoneBCells: readonly string[]
): DetectedConnection | null {
  const a = normalizeCells(zoneACells);
  const b = normalizeCells(zoneBCells);
  if (a.length === 0 || b.length === 0) return null;
  const aRes = getResolution(a[0]);
  const bRes = getResolution(b[0]);
  return detectBetweenCells(a, b, aRes, bRes);
}

// --------------------------------------------------------------------------
// Persistence helpers
// --------------------------------------------------------------------------

interface HubPoint {
  name: string;
  lat: number;
  lng: number;
}

interface ZoneSlim {
  id: number;
  owner_user_id: number;
  cells: string[];
  transport_mode: string | null;
  /**
   * Resolution stored on the row. Cached here so cross-resolution
   * detection doesn't need to inspect cells on every pair in the O(N²) loop.
   * Falls back to the first cell's actual resolution if the column is null.
   */
  resolution: number;
  /** Air/sea hub terminals (null for land zones). */
  departure_hub: HubPoint | null;
  arrival_hub: HubPoint | null;
}

/** Columns every zone fetch needs so hub detection has the terminal coords. */
const ZONE_SLIM_COLUMNS = `id, owner_user_id, h3_cells, transport_mode, resolution,
  departure_hub_name, departure_hub_lat, departure_hub_lng,
  arrival_hub_name, arrival_hub_lat, arrival_hub_lng`;

function parseHubPoint(
  row: Record<string, unknown>,
  prefix: "departure_hub" | "arrival_hub"
): HubPoint | null {
  const name = row[`${prefix}_name`];
  const lat = Number(row[`${prefix}_lat`]);
  const lng = Number(row[`${prefix}_lng`]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { name: name == null ? "" : String(name), lat, lng };
}

function parseZoneRow(row: Record<string, unknown>): ZoneSlim {
  let raw = row.h3_cells as unknown;
  let cells: string[] = [];
  if (Array.isArray(raw)) {
    cells = raw.map(String);
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) cells = parsed.map(String);
    } catch {
      cells = [];
    }
  }
  const normalized = normalizeCells(cells);
  let resolution = Number(row.resolution);
  if (!Number.isFinite(resolution) && normalized.length > 0) {
    try {
      resolution = getResolution(normalized[0]);
    } catch {
      resolution = 0;
    }
  }
  return {
    id: Number(row.id),
    owner_user_id: Number(row.owner_user_id),
    cells: normalized,
    transport_mode: row.transport_mode == null ? null : String(row.transport_mode),
    resolution: Number.isFinite(resolution) ? resolution : 0,
    departure_hub: parseHubPoint(row, "departure_hub"),
    arrival_hub: parseHubPoint(row, "arrival_hub"),
  };
}

async function fetchActiveZones(client: PoolClient | typeof pool): Promise<ZoneSlim[]> {
  const result = await client.query(
    `SELECT ${ZONE_SLIM_COLUMNS}
     FROM driver_zones
     WHERE available = TRUE
     ORDER BY id`
  );
  return result.rows.map(parseZoneRow);
}

async function fetchZoneById(
  client: PoolClient | typeof pool,
  zoneId: number
): Promise<ZoneSlim | null> {
  const result = await client.query(
    `SELECT ${ZONE_SLIM_COLUMNS}
     FROM driver_zones
     WHERE id = $1 AND available = TRUE`,
    [zoneId]
  );
  if (result.rowCount === 0) return null;
  return parseZoneRow(result.rows[0]);
}

interface PendingConnection {
  zone_a_id: number;
  zone_b_id: number;
  transport_a_id: number;
  transport_b_id: number;
  connection_type: ConnectionType;
  transfer_cells: string[];
  adjacent_cell_pairs: AdjacentCellPair[];
  recommended_transfer_cell: string | null;
  transport_method_a: string | null;
  transport_method_b: string | null;
  hub_role_a: HubRole | null;
  hub_role_b: HubRole | null;
}

/** Air / sea transport is hub/port based — no cell-level handoff surface. */
function isHubTransportMode(mode: string | null): boolean {
  const v = (mode ?? "").toLowerCase();
  return v === "air" || v === "sea";
}

interface DetectedHubConnection {
  /** Which hub of the air/sea zone the land zone meets. */
  hub_role: HubRole;
  connection_type: ConnectionType;
  /** The land-zone cell at (or next to) the hub — used as the transfer cell. */
  transfer_cell: string;
}

/**
 * Point-based handoff between an air/sea zone and a land zone.
 *
 * Real-world flow: a land transporter delivers cargo to the departure hub
 * (airport/port), and another land transporter collects it at the arrival
 * hub. So we test whether the land zone *covers* (contains) or *touches*
 * (ring-1 adjacent to) each hub point, and anchor the connection to that hub.
 *
 * Containment is preferred over adjacency, and departure over arrival on a
 * tie, because only one row can exist per zone pair.
 */
function detectHubToLand(hubZone: ZoneSlim, landZone: ZoneSlim): DetectedHubConnection | null {
  if (landZone.cells.length === 0) return null;
  const landSet = new Set(landZone.cells);
  const landRes = landZone.resolution;

  const candidates: { role: HubRole; hub: HubPoint }[] = [];
  if (hubZone.departure_hub) candidates.push({ role: "departure", hub: hubZone.departure_hub });
  if (hubZone.arrival_hub) candidates.push({ role: "arrival", hub: hubZone.arrival_hub });

  let adjacentMatch: DetectedHubConnection | null = null;

  for (const { role, hub } of candidates) {
    let hubCell: string;
    try {
      hubCell = latLngToCell(hub.lat, hub.lng, landRes);
    } catch {
      continue;
    }
    // Containment — the hub sits inside the land zone's coverage.
    if (landSet.has(hubCell)) {
      return { hub_role: role, connection_type: "hub", transfer_cell: hubCell };
    }
    // Touching — a ring-1 neighbour of the hub cell belongs to the land zone.
    if (!adjacentMatch) {
      let ring: string[];
      try {
        ring = gridDisk(hubCell, 1);
      } catch {
        ring = [];
      }
      for (const neighbour of ring) {
        if (neighbour !== hubCell && landSet.has(neighbour)) {
          adjacentMatch = { hub_role: role, connection_type: "hub", transfer_cell: neighbour };
          break;
        }
      }
    }
  }

  return adjacentMatch;
}

/**
 * Build a hub PendingConnection. `hubZone` meets `landZone` at `hubRole`.
 * Ordering is normalized so the lower zone id is `zone_a`; the hub role is
 * recorded on whichever side is the air/sea zone.
 */
function buildHubPending(
  hubZone: ZoneSlim,
  landZone: ZoneSlim,
  detected: DetectedHubConnection
): PendingConnection {
  const [a, b] = hubZone.id < landZone.id ? [hubZone, landZone] : [landZone, hubZone];
  const hubIsA = a.id === hubZone.id;
  return {
    zone_a_id: a.id,
    zone_b_id: b.id,
    transport_a_id: a.owner_user_id,
    transport_b_id: b.owner_user_id,
    connection_type: "hub",
    transfer_cells: [detected.transfer_cell],
    adjacent_cell_pairs: [],
    recommended_transfer_cell: detected.transfer_cell,
    transport_method_a: a.transport_mode,
    transport_method_b: b.transport_mode,
    hub_role_a: hubIsA ? detected.hub_role : null,
    hub_role_b: hubIsA ? null : detected.hub_role,
  };
}

/**
 * Resolve the connection between any two zones, dispatching on whether each
 * side is hub-based (air/sea) or land. Returns null when unrelated.
 */
function detectPair(z1: ZoneSlim, z2: ZoneSlim): PendingConnection | null {
  const z1Hub = isHubTransportMode(z1.transport_mode);
  const z2Hub = isHubTransportMode(z2.transport_mode);

  // Air/sea ↔ land: point-based hub handoff.
  if (z1Hub !== z2Hub) {
    const hubZone = z1Hub ? z1 : z2;
    const landZone = z1Hub ? z2 : z1;
    const detected = detectHubToLand(hubZone, landZone);
    if (!detected) return null;
    return buildHubPending(hubZone, landZone, detected);
  }

  // Two air/sea zones don't share a cell-level handoff surface. A shared
  // airport/port could link them, but that's out of scope here.
  if (z1Hub && z2Hub) return null;

  // Land ↔ land: existing area overlap / adjacency.
  const detected = detectBetweenCells(z1.cells, z2.cells, z1.resolution, z2.resolution);
  if (!detected) return null;
  return buildPending(z1, z2, detected);
}

/**
 * Normalize ordering so the lower zone id always lives in `zone_a_id`.
 * This pairs with the (zone_a_id, zone_b_id) UNIQUE constraint to
 * guarantee A-B and B-A can never both be stored.
 */
function buildPending(
  z1: ZoneSlim,
  z2: ZoneSlim,
  detected: DetectedConnection
): PendingConnection {
  const [a, b] = z1.id < z2.id ? [z1, z2] : [z2, z1];
  // If we flipped order, the adjacency pair direction must flip too so
  // `from_cell` always refers to a cell in zone_a.
  const flipped = a.id !== z1.id;

  // For air/sea legs the package is only ever picked up / dropped off at the
  // hub airport or port — what happens between two hubs is undefined. The
  // H3-cell overlap we detect for these zones is just a geographic catchment
  // coincidence, so we keep the *relationship* (the edge) but strip the
  // cell-level transfer/adjacency payload that would otherwise paint a
  // misleading mid-route handoff on the map.
  const hubConnection =
    isHubTransportMode(a.transport_mode) || isHubTransportMode(b.transport_mode);

  const pairs = hubConnection
    ? []
    : flipped
    ? detected.adjacent_cell_pairs.map((p) => ({ from_cell: p.to_cell, to_cell: p.from_cell }))
    : detected.adjacent_cell_pairs;

  return {
    zone_a_id: a.id,
    zone_b_id: b.id,
    transport_a_id: a.owner_user_id,
    transport_b_id: b.owner_user_id,
    connection_type: detected.connection_type,
    transfer_cells: hubConnection ? [] : detected.transfer_cells,
    adjacent_cell_pairs: pairs,
    recommended_transfer_cell: hubConnection ? null : detected.recommended_transfer_cell,
    transport_method_a: a.transport_mode,
    transport_method_b: b.transport_mode,
    hub_role_a: null,
    hub_role_b: null,
  };
}

async function upsertConnection(client: PoolClient, c: PendingConnection): Promise<void> {
  await client.query(
    `INSERT INTO zone_connections
       (zone_a_id, zone_b_id, transport_a_id, transport_b_id,
        connection_type, transfer_cells, adjacent_cell_pairs,
        recommended_transfer_cell,
        transport_method_a, transport_method_b,
        hub_role_a, hub_role_b, is_active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, TRUE, NOW())
     ON CONFLICT (zone_a_id, zone_b_id) DO UPDATE SET
       connection_type           = EXCLUDED.connection_type,
       transfer_cells            = EXCLUDED.transfer_cells,
       adjacent_cell_pairs       = EXCLUDED.adjacent_cell_pairs,
       recommended_transfer_cell = EXCLUDED.recommended_transfer_cell,
       transport_method_a        = EXCLUDED.transport_method_a,
       transport_method_b        = EXCLUDED.transport_method_b,
       hub_role_a                = EXCLUDED.hub_role_a,
       hub_role_b                = EXCLUDED.hub_role_b,
       is_active                 = TRUE,
       updated_at                = NOW()`,
    [
      c.zone_a_id,
      c.zone_b_id,
      c.transport_a_id,
      c.transport_b_id,
      c.connection_type,
      JSON.stringify(c.transfer_cells),
      JSON.stringify(c.adjacent_cell_pairs),
      c.recommended_transfer_cell,
      c.transport_method_a,
      c.transport_method_b,
      c.hub_role_a,
      c.hub_role_b,
    ]
  );
}

// --------------------------------------------------------------------------
// Recalculation
// --------------------------------------------------------------------------

/**
 * Wipe and rebuild the entire zone-connection graph. O(N^2) over active
 * zones, which is fine for the scales we target (10s–100s of zones). We
 * run inside a transaction so the dashboard never sees a partial graph.
 */
export async function recalculateAllZoneConnections(): Promise<RecalcStats> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const zones = await fetchActiveZones(client);

    // Truncate so removed zones / changed cells don't leave stale rows.
    await client.query("TRUNCATE zone_connections RESTART IDENTITY");

    let overlap = 0;
    let adjacent = 0;
    let hub = 0;
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const pending = detectPair(zones[i], zones[j]);
        if (!pending) continue;
        if (pending.connection_type === "overlap") overlap++;
        else if (pending.connection_type === "hub") hub++;
        else adjacent++;
        await upsertConnection(client, pending);
      }
    }

    await client.query("COMMIT");
    return {
      total_connections: overlap + adjacent + hub,
      overlap_connections: overlap,
      adjacent_connections: adjacent,
      hub_connections: hub,
      zones_compared: zones.length,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Recalculate only the connections involving `zoneId`. This is the cheap
 * incremental update called from the driver-zone CRUD hooks so the graph
 * stays in sync without paying O(N^2) on every single edit.
 */
export async function recalculateConnectionsForZone(zoneId: number): Promise<RecalcStats> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const target = await fetchZoneById(client, zoneId);

    // Always remove existing connections involving this zone first — that
    // way an "edit that removed cells" or "zone marked unavailable" cleanly
    // drops connections that no longer apply.
    await client.query(
      `DELETE FROM zone_connections WHERE zone_a_id = $1 OR zone_b_id = $1`,
      [zoneId]
    );

    // A hub (air/sea) zone with no land coverage of its own still needs to
    // connect to land zones at its terminals, so we only bail when the zone
    // has neither cells nor hubs.
    const targetIsHub = target != null && isHubTransportMode(target.transport_mode);
    if (!target || (target.cells.length === 0 && !targetIsHub)) {
      await client.query("COMMIT");
      return {
        total_connections: 0,
        overlap_connections: 0,
        adjacent_connections: 0,
        hub_connections: 0,
        zones_compared: 0,
      };
    }

    const others = await client.query(
      `SELECT ${ZONE_SLIM_COLUMNS}
       FROM driver_zones
       WHERE id <> $1 AND available = TRUE`,
      [zoneId]
    );
    const otherZones = others.rows.map(parseZoneRow);

    let overlap = 0;
    let adjacent = 0;
    let hub = 0;
    for (const other of otherZones) {
      const pending = detectPair(target, other);
      if (!pending) continue;
      if (pending.connection_type === "overlap") overlap++;
      else if (pending.connection_type === "hub") hub++;
      else adjacent++;
      await upsertConnection(client, pending);
    }

    await client.query("COMMIT");
    return {
      total_connections: overlap + adjacent + hub,
      overlap_connections: overlap,
      adjacent_connections: adjacent,
      hub_connections: hub,
      zones_compared: otherZones.length,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Drop every connection involving the zone — used right before a zone is
 * deleted so we don't rely on ON DELETE CASCADE timing in callers that
 * delete in their own transaction.
 */
export async function deactivateConnectionsForZone(zoneId: number): Promise<void> {
  await pool.query(
    `DELETE FROM zone_connections WHERE zone_a_id = $1 OR zone_b_id = $1`,
    [zoneId]
  );
}

// --------------------------------------------------------------------------
// Read API
// --------------------------------------------------------------------------

/**
 * Each connection row is shipped with both zones' full H3 cell lists so the
 * map can render the handoff for *any* viewer (drivers can't otherwise access
 * the other driver's zone via /api/driver-zones). `cell_count` is computed
 * server-side via jsonb_array_length so the UI doesn't have to recount.
 */
const CONNECTION_SELECT = `
  SELECT
    c.id, c.zone_a_id, c.zone_b_id, c.transport_a_id, c.transport_b_id,
    c.connection_type, c.transfer_cells, c.adjacent_cell_pairs,
    c.recommended_transfer_cell,
    c.transport_method_a, c.transport_method_b,
    c.hub_role_a, c.hub_role_b, c.is_active,
    c.created_at, c.updated_at,
    za.zone_name                    AS zone_a_name,
    jsonb_array_length(za.h3_cells) AS zone_a_cell_count,
    za.resolution                   AS zone_a_resolution,
    za.h3_cells                     AS zone_a_cells,
    za.departure_hub_name           AS zone_a_departure_hub_name,
    za.departure_hub_lat            AS zone_a_departure_hub_lat,
    za.departure_hub_lng            AS zone_a_departure_hub_lng,
    za.arrival_hub_name             AS zone_a_arrival_hub_name,
    za.arrival_hub_lat              AS zone_a_arrival_hub_lat,
    za.arrival_hub_lng              AS zone_a_arrival_hub_lng,
    za.departure_time               AS zone_a_departure_time,
    za.arrival_time                 AS zone_a_arrival_time,
    zb.zone_name                    AS zone_b_name,
    jsonb_array_length(zb.h3_cells) AS zone_b_cell_count,
    zb.resolution                   AS zone_b_resolution,
    zb.h3_cells                     AS zone_b_cells,
    zb.departure_hub_name           AS zone_b_departure_hub_name,
    zb.departure_hub_lat            AS zone_b_departure_hub_lat,
    zb.departure_hub_lng            AS zone_b_departure_hub_lng,
    zb.arrival_hub_name             AS zone_b_arrival_hub_name,
    zb.arrival_hub_lat              AS zone_b_arrival_hub_lat,
    zb.arrival_hub_lng              AS zone_b_arrival_hub_lng,
    zb.departure_time               AS zone_b_departure_time,
    zb.arrival_time                 AS zone_b_arrival_time,
    ua.full_name                    AS transport_a_name,
    ub.full_name                    AS transport_b_name
  FROM zone_connections c
  JOIN driver_zones za ON za.id = c.zone_a_id
  JOIN driver_zones zb ON zb.id = c.zone_b_id
  JOIN users        ua ON ua.id = c.transport_a_id
  JOIN users        ub ON ub.id = c.transport_b_id
`;

export interface ZoneConnectionAccess {
  userId: number;
  role: UserRole;
}

function parseJsonbCells(raw: unknown): string[] {
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

function parseJsonbPairs(raw: unknown): AdjacentCellPair[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((p): p is { from_cell: unknown; to_cell: unknown } =>
        Boolean(p && typeof p === "object" && "from_cell" in p && "to_cell" in p)
      )
      .map((p) => ({ from_cell: String(p.from_cell), to_cell: String(p.to_cell) }));
  }
  if (typeof raw === "string") {
    try {
      return parseJsonbPairs(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function parsePartyHub(
  row: Record<string, unknown>,
  prefix: string
): { name: string; lat: number; lng: number } | null {
  const name = row[`${prefix}_name`];
  const lat = row[`${prefix}_lat`];
  const lng = row[`${prefix}_lng`];
  if (name == null || lat == null || lng == null) return null;
  const latN = Number(lat);
  const lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return null;
  return { name: String(name).trim(), lat: latN, lng: lngN };
}

function rowToResponse(row: Record<string, unknown>): ZoneConnectionResponse {
  const transferCells = parseJsonbCells(row.transfer_cells);
  const adjacentPairs = parseJsonbPairs(row.adjacent_cell_pairs);
  return {
    id: Number(row.id),
    connection_type: String(row.connection_type) as "overlap" | "adjacent" | "hub",
    transfer_cells: transferCells,
    adjacent_cell_pairs: adjacentPairs,
    recommended_transfer_cell:
      row.recommended_transfer_cell == null ? null : String(row.recommended_transfer_cell),
    transport_method_a: row.transport_method_a == null ? null : String(row.transport_method_a),
    transport_method_b: row.transport_method_b == null ? null : String(row.transport_method_b),
    hub_role_a: (row.hub_role_a == null ? null : String(row.hub_role_a)) as HubRole | null,
    hub_role_b: (row.hub_role_b == null ? null : String(row.hub_role_b)) as HubRole | null,
    transfer_cell_count: transferCells.length,
    adjacent_pair_count: adjacentPairs.length,
    zone_a: {
      id: Number(row.zone_a_id),
      zone_name: String(row.zone_a_name ?? ""),
      transport_id: Number(row.transport_a_id),
      transport_name: String(row.transport_a_name ?? ""),
      transport_method: row.transport_method_a == null ? null : String(row.transport_method_a),
      cell_count: Number(row.zone_a_cell_count ?? 0),
      resolution: Number(row.zone_a_resolution ?? 0),
      cells: parseJsonbCells(row.zone_a_cells),
      departure_hub: parsePartyHub(row, "zone_a_departure_hub"),
      arrival_hub: parsePartyHub(row, "zone_a_arrival_hub"),
      departure_time: row.zone_a_departure_time == null ? null : String(row.zone_a_departure_time),
      arrival_time: row.zone_a_arrival_time == null ? null : String(row.zone_a_arrival_time),
    },
    zone_b: {
      id: Number(row.zone_b_id),
      zone_name: String(row.zone_b_name ?? ""),
      transport_id: Number(row.transport_b_id),
      transport_name: String(row.transport_b_name ?? ""),
      transport_method: row.transport_method_b == null ? null : String(row.transport_method_b),
      cell_count: Number(row.zone_b_cell_count ?? 0),
      resolution: Number(row.zone_b_resolution ?? 0),
      cells: parseJsonbCells(row.zone_b_cells),
      departure_hub: parsePartyHub(row, "zone_b_departure_hub"),
      arrival_hub: parsePartyHub(row, "zone_b_arrival_hub"),
      departure_time: row.zone_b_departure_time == null ? null : String(row.zone_b_departure_time),
      arrival_time: row.zone_b_arrival_time == null ? null : String(row.zone_b_arrival_time),
    },
    is_active: Boolean(row.is_active),
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

/**
 * Returns the list of connections, filtered + scoped to what the caller
 * is allowed to see.
 *
 * Visibility:
 *  - admin: every connection
 *  - driver: only connections that include one of their zones
 *  - sender / receiver: every active connection (they consume the graph
 *    when planning handoffs but can't mutate it)
 */
export async function listZoneConnections(
  ctx: ZoneConnectionAccess,
  filters: ListConnectionFilters
): Promise<ZoneConnectionResponse[]> {
  const params: unknown[] = [];
  const where: string[] = ["c.is_active = TRUE"];

  if (ctx.role === "driver") {
    params.push(ctx.userId);
    where.push(`(c.transport_a_id = $${params.length} OR c.transport_b_id = $${params.length})`);
  }
  if (filters.connection_type) {
    params.push(filters.connection_type);
    where.push(`c.connection_type = $${params.length}`);
  }
  if (filters.transport_id) {
    params.push(filters.transport_id);
    where.push(`(c.transport_a_id = $${params.length} OR c.transport_b_id = $${params.length})`);
  }
  if (filters.zone_id) {
    params.push(filters.zone_id);
    where.push(`(c.zone_a_id = $${params.length} OR c.zone_b_id = $${params.length})`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const result = await pool.query(
    `${CONNECTION_SELECT} ${whereSql} ORDER BY c.created_at DESC, c.id DESC`,
    params
  );
  return result.rows.map(rowToResponse);
}

export async function getZoneConnectionById(
  id: number,
  ctx: ZoneConnectionAccess
): Promise<ZoneConnectionResponse | null> {
  const params: unknown[] = [id];
  let scope = "";
  if (ctx.role === "driver") {
    params.push(ctx.userId);
    scope = ` AND (c.transport_a_id = $${params.length} OR c.transport_b_id = $${params.length})`;
  }
  const result = await pool.query(
    `${CONNECTION_SELECT} WHERE c.id = $1${scope} LIMIT 1`,
    params
  );
  if (result.rowCount === 0) return null;
  return rowToResponse(result.rows[0]);
}

export async function listConnectionsForZone(
  zoneId: number,
  ctx: ZoneConnectionAccess
): Promise<ZoneConnectionResponse[]> {
  return listZoneConnections(ctx, { zone_id: zoneId });
}

/**
 * Soft delete — flip `is_active` to false. We keep the row so historical
 * connections aren't permanently lost; the next recalculation will revive
 * it if the geometry still warrants a connection.
 */
export async function deactivateConnection(
  id: number,
  ctx: ZoneConnectionAccess
): Promise<boolean> {
  if (ctx.role !== "admin" && ctx.role !== "driver") return false;

  let where = "WHERE id = $1";
  const params: unknown[] = [id];
  if (ctx.role === "driver") {
    params.push(ctx.userId);
    where += ` AND (transport_a_id = $${params.length} OR transport_b_id = $${params.length})`;
  }
  const result = await pool.query(
    `UPDATE zone_connections SET is_active = FALSE, updated_at = NOW() ${where}`,
    params
  );
  return (result.rowCount ?? 0) > 0;
}

/** Lightweight helper for the row-level model export. */
export type { ZoneConnectionRow };
