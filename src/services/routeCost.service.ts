import { cellToLatLng } from "h3-js";
import { pool } from "../database";
import type { OrderResponse } from "../models/order.model";
import type {
  OrderRouteCostComparisonResponse,
  RouteCostStatus,
  RouteCostSummaryResponse,
  RouteSegmentCostResponse,
  SegmentCostStatus,
} from "../models/routeCost.model";
import { getOrderById, type OrderContext } from "./order.service";
import {
  DEFAULT_PREVIEW_MAX_DEPTH,
  previewOrderZoneConnectionsByCoordinates,
} from "./orderZoneConnection.service";
import {
  calculateSegmentCost,
  calculateSegmentDistanceH3,
  deriveSegmentsFromRoute,
  haversineKm,
  type DerivedSegment,
  type SegmentRate,
} from "./costCalculation.service";

export class RouteCostError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function parseJsonIntArray(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (typeof raw === "string") {
    try {
      return parseJsonIntArray(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Stable signature for a route based on its ordered zone ids. Used to carry
 * manually-entered segment costs across a full recalculation, where the
 * `order_routes` rows are dropped and recreated with new ids.
 */
function zoneSignature(zoneIds: number[]): string {
  return zoneIds.join(",");
}

type RouteChain = { zone_ids: number[]; connection_ids: number[] };

/** Serialize route re-sync for one order so concurrent callers don't race on DELETE/INSERT. */
const orderResyncQueues = new Map<number, Promise<unknown>>();

async function withOrderResyncLock<T>(orderId: number, fn: () => Promise<T>): Promise<T> {
  const prev = orderResyncQueues.get(orderId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  orderResyncQueues.set(
    orderId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function chainSignature(chain: RouteChain): string {
  return `${chain.zone_ids.join(",")}|${chain.connection_ids.join(",")}`;
}

function storedRouteSignature(route: { zone_ids: unknown; connection_ids: unknown }): string {
  return chainSignature({
    zone_ids: parseJsonIntArray(route.zone_ids),
    connection_ids: parseJsonIntArray(route.connection_ids),
  });
}

function routeChainsMatch(
  live: RouteChain[],
  stored: Array<{ zone_ids: unknown; connection_ids: unknown }>
): boolean {
  if (live.length !== stored.length) return false;
  const liveSigs = live.map(chainSignature).sort();
  const storedSigs = stored.map(storedRouteSignature).sort();
  return liveSigs.every((sig, i) => sig === storedSigs[i]);
}

async function fetchLiveRouteChains(order: OrderResponse): Promise<RouteChain[]> {
  if (
    order.sender_lat == null ||
    order.sender_lng == null ||
    order.destination_lat == null ||
    order.destination_lng == null
  ) {
    return [];
  }

  const preview = await previewOrderZoneConnectionsByCoordinates({
    source_lat: order.sender_lat,
    source_lng: order.sender_lng,
    destination_lat: order.destination_lat,
    destination_lng: order.destination_lng,
    source_name: order.source_name,
    source_address: order.sender_address,
    destination_name: order.receiver_name,
    destination_address: order.destination_address,
    max_depth: DEFAULT_PREVIEW_MAX_DEPTH,
  });

  return preview.possible_connection_chains;
}

async function orderRoutesNeedResync(order: OrderResponse, liveChains: RouteChain[]): Promise<boolean> {
  const stored = await pool.query(
    `SELECT zone_ids, connection_ids FROM order_routes WHERE order_id = $1 ORDER BY route_index`,
    [order.id]
  );
  if (stored.rowCount === 0) return true;
  return !routeChainsMatch(liveChains, stored.rows);
}

/**
 * Snapshot every manual segment cost for an order, keyed by
 * `${zoneSignature}::${segment_index}`, so a recalculation can re-apply them
 * even though the underlying route/segment rows are recreated.
 */
async function snapshotManualCosts(orderId: number): Promise<Map<string, number>> {
  const result = await pool.query(
    `SELECT r.zone_ids, sc.segment_index, sc.manual_cost
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     WHERE r.order_id = $1 AND sc.cost_status = 'manual' AND sc.manual_cost IS NOT NULL`,
    [orderId]
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    const sig = zoneSignature(parseJsonIntArray(row.zone_ids));
    map.set(`${sig}::${Number(row.segment_index)}`, Number(row.manual_cost));
  }
  return map;
}

async function loadZoneMetaForIds(
  zoneIds: number[]
): Promise<
  Map<
    number,
    { owner_user_id: number; transport_mode: string | null; zone_name: string; resolution: number | null }
  >
> {
  if (zoneIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, owner_user_id, transport_mode, zone_name, resolution FROM driver_zones WHERE id = ANY($1::int[])`,
    [zoneIds]
  );
  const map = new Map<
    number,
    { owner_user_id: number; transport_mode: string | null; zone_name: string; resolution: number | null }
  >();
  for (const row of result.rows) {
    map.set(Number(row.id), {
      owner_user_id: Number(row.owner_user_id),
      transport_mode: row.transport_mode == null ? null : String(row.transport_mode),
      zone_name: String(row.zone_name ?? ""),
      resolution:
        row.resolution == null || !Number.isFinite(Number(row.resolution))
          ? null
          : Number(row.resolution),
    });
  }
  return map;
}

async function loadZoneCentroids(
  zoneIds: number[]
): Promise<Map<number, { lat: number; lng: number; transport_method: string | null }>> {
  if (zoneIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT z.id, z.transport_mode,
            COALESCE(
              (SELECT elem FROM jsonb_array_elements_text(z.h3_cells) WITH ORDINALITY AS t(elem, ord) WHERE ord = 1 LIMIT 1),
              NULL
            ) AS sample_cell
     FROM driver_zones z
     WHERE z.id = ANY($1::int[])`,
    [zoneIds]
  );
  const map = new Map<number, { lat: number; lng: number; transport_method: string | null }>();
  for (const row of result.rows) {
    const cell = row.sample_cell != null ? String(row.sample_cell) : null;
    if (!cell) continue;
    try {
      const [lat, lng] = cellToLatLng(cell);
      map.set(Number(row.id), {
        lat,
        lng,
        transport_method: row.transport_mode == null ? null : String(row.transport_mode),
      });
    } catch {
      /* skip */
    }
  }
  return map;
}

/**
 * Load per-zone pricing rules. A zone is only included if it has at least one
 * rate field configured; zones with no pricing are omitted so their segment is
 * reported as "missing cost" (requires manual entry).
 */
async function loadZoneRates(zoneIds: number[]): Promise<Map<number, SegmentRate>> {
  if (zoneIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, currency, base_fee, cost_per_h3_cell, cost_per_km, cost_per_kg,
            cost_per_volume_unit, time_of_day_factor, minimum_fee
     FROM driver_zones WHERE id = ANY($1::int[])`,
    [zoneIds]
  );
  const num = (v: unknown): number | null =>
    v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  const map = new Map<number, SegmentRate>();
  for (const row of result.rows) {
    const rate: SegmentRate = {
      currency: String(row.currency ?? "CAD"),
      base_fee: num(row.base_fee),
      cost_per_h3_cell: num(row.cost_per_h3_cell),
      cost_per_km: num(row.cost_per_km),
      cost_per_kg: num(row.cost_per_kg),
      cost_per_volume_unit: num(row.cost_per_volume_unit),
      time_of_day_factor: num(row.time_of_day_factor),
      minimum_fee: num(row.minimum_fee),
    };
    const configured =
      rate.base_fee != null ||
      rate.cost_per_h3_cell != null ||
      rate.cost_per_km != null ||
      rate.cost_per_kg != null ||
      rate.cost_per_volume_unit != null ||
      rate.minimum_fee != null;
    if (configured) map.set(Number(row.id), rate);
  }
  return map;
}

/**
 * For air/sea zones, the leg is a line between two terminals. Precompute the
 * great-circle distance (km) between each such zone's departure and arrival
 * hubs so the segment can be priced per km.
 */
async function loadZoneLineDistances(zoneIds: number[]): Promise<Map<number, number>> {
  if (zoneIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, transport_mode,
            departure_hub_lat, departure_hub_lng, arrival_hub_lat, arrival_hub_lng
     FROM driver_zones WHERE id = ANY($1::int[])`,
    [zoneIds]
  );
  const map = new Map<number, number>();
  for (const row of result.rows) {
    const mode = String(row.transport_mode ?? "land");
    if (mode !== "air" && mode !== "sea") continue;
    const km = haversineKm(
      row.departure_hub_lat == null ? null : Number(row.departure_hub_lat),
      row.departure_hub_lng == null ? null : Number(row.departure_hub_lng),
      row.arrival_hub_lat == null ? null : Number(row.arrival_hub_lat),
      row.arrival_hub_lng == null ? null : Number(row.arrival_hub_lng)
    );
    if (km != null) map.set(Number(row.id), km);
  }
  return map;
}

interface LatLng {
  lat: number;
  lng: number;
}

/** Centroid of a connection's transfer (border-crossing) cells. */
function transferPointFromCells(cells: string[]): LatLng | null {
  if (!cells || cells.length === 0) return null;
  const sample = cells.slice(0, 20);
  let lat = 0;
  let lng = 0;
  let n = 0;
  for (const c of sample) {
    try {
      const [la, lo] = cellToLatLng(c);
      lat += la;
      lng += lo;
      n++;
    } catch {
      /* skip invalid cell */
    }
  }
  if (n === 0) return null;
  return { lat: lat / n, lng: lng / n };
}

/**
 * Load the persisted zone connections used by a route so we know the actual
 * border-crossing cells where the package hands off between zones. Those are
 * the entry/exit points used to count cells traversed within a land zone.
 */
async function loadConnectionsByIds(
  ids: number[]
): Promise<Map<number, { zone_a_id: number; zone_b_id: number; transfer_cells: string[] }>> {
  const map = new Map<number, { zone_a_id: number; zone_b_id: number; transfer_cells: string[] }>();
  if (ids.length === 0) return map;
  const result = await pool.query(
    `SELECT id, zone_a_id, zone_b_id, transfer_cells FROM zone_connections WHERE id = ANY($1::int[])`,
    [ids]
  );
  for (const row of result.rows) {
    let cells: string[] = [];
    const raw = row.transfer_cells;
    if (Array.isArray(raw)) cells = raw.map(String);
    else if (typeof raw === "string") {
      try {
        cells = JSON.parse(raw);
      } catch {
        cells = [];
      }
    }
    map.set(Number(row.id), {
      zone_a_id: Number(row.zone_a_id),
      zone_b_id: Number(row.zone_b_id),
      transfer_cells: cells,
    });
  }
  return map;
}

/**
 * Compute the path-accurate distance for each segment:
 *  - Land zones: the number of H3 cells the package travels through, measured
 *    from where it enters the zone (sender or the transfer cell from the
 *    previous zone) to where it exits (the transfer cell to the next zone, or
 *    receiver). Summed across the leg's zones. This is "only the cells crossed",
 *    not the zone's full cell count.
 *  - Air/sea zones: the routed great-circle distance between the zone's
 *    departure and arrival hubs, summed across the leg's zones.
 */
function computeSegmentDistances(
  zoneIds: number[],
  connectionIds: number[],
  order: OrderResponse,
  zoneMeta: Map<number, { transport_mode: string | null; resolution: number | null }>,
  zoneCoords: Map<number, { lat: number; lng: number }>,
  zoneLineKm: Map<number, number>,
  connectionsById: Map<number, { zone_a_id: number; zone_b_id: number; transfer_cells: string[] }>,
  segments: DerivedSegment[]
): Map<number, { distance_h3_cells: number | null; distance_km: number | null }> {
  const transferAt = (i: number): LatLng | null => {
    const connId = connectionIds[i];
    if (connId != null) {
      const conn = connectionsById.get(connId);
      const tp = conn ? transferPointFromCells(conn.transfer_cells) : null;
      if (tp) return tp;
    }
    // Fallback: midpoint of the two zone centroids.
    const a = zoneCoords.get(zoneIds[i]);
    const b = zoneCoords.get(zoneIds[i + 1]);
    if (a && b) return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    return null;
  };

  const sender: LatLng | null =
    order.sender_lat != null && order.sender_lng != null
      ? { lat: order.sender_lat, lng: order.sender_lng }
      : null;
  const receiver: LatLng | null =
    order.destination_lat != null && order.destination_lng != null
      ? { lat: order.destination_lat, lng: order.destination_lng }
      : null;

  const perZone = new Map<number, { cells: number | null; km: number | null }>();
  for (let i = 0; i < zoneIds.length; i++) {
    const zoneId = zoneIds[i];
    const meta = zoneMeta.get(zoneId);
    const mode = meta?.transport_mode ?? "land";
    if (mode === "air" || mode === "sea") {
      perZone.set(zoneId, { cells: null, km: zoneLineKm.get(zoneId) ?? null });
      continue;
    }
    const centroid = zoneCoords.get(zoneId) ?? null;
    const entry = (i === 0 ? sender : transferAt(i - 1)) ?? centroid;
    const exit = (i === zoneIds.length - 1 ? receiver : transferAt(i)) ?? centroid;
    if (!entry || !exit) {
      perZone.set(zoneId, { cells: null, km: null });
      continue;
    }
    // Count cells at the zone's OWN resolution (the cells the transporter
    // actually drew), so the per-cell price matches their zone granularity.
    const d = calculateSegmentDistanceH3(
      entry.lat,
      entry.lng,
      exit.lat,
      exit.lng,
      meta?.resolution ?? undefined
    );
    perZone.set(zoneId, { cells: d.distance_h3_cells, km: d.distance_km });
  }

  const bySegment = new Map<number, { distance_h3_cells: number | null; distance_km: number | null }>();
  for (const seg of segments) {
    const line = seg.transport_method === "air" || seg.transport_method === "sea";
    let cells = 0;
    let km = 0;
    let haveCells = false;
    let haveKm = false;
    for (const zid of seg.zone_ids) {
      const d = perZone.get(zid);
      if (!d) continue;
      if (d.cells != null) {
        cells += d.cells;
        haveCells = true;
      }
      if (d.km != null) {
        km += d.km;
        haveKm = true;
      }
    }
    bySegment.set(seg.segment_index, {
      distance_h3_cells: line ? null : haveCells ? cells : null,
      distance_km: haveKm ? Math.round(km * 100) / 100 : null,
    });
  }
  return bySegment;
}

async function loadTransporterNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const result = await pool.query(`SELECT id, full_name FROM users WHERE id = ANY($1::int[])`, [ids]);
  const map = new Map<number, string>();
  for (const row of result.rows) {
    map.set(Number(row.id), String(row.full_name ?? ""));
  }
  return map;
}

function nodeLabel(nodeId: string, zoneNames: Map<number, string>): string {
  if (nodeId === "sender") return "Sender";
  if (nodeId === "receiver") return "Receiver";
  const zid = Number(nodeId);
  if (Number.isFinite(zid)) {
    const name = zoneNames.get(zid);
    return name ? `Zone: ${name}` : `Zone #${zid}`;
  }
  return nodeId;
}

function summarizeRouteStatus(
  segments: { cost_status: SegmentCostStatus; final_cost: number | null }[]
): { status: RouteCostStatus; missing_segment_count: number; total_final_cost: number | null } {
  const missing = segments.filter((s) => s.cost_status === "missing").length;
  const withFinal = segments.filter((s) => s.final_cost != null);
  const total =
    withFinal.length > 0
      ? Math.round(withFinal.reduce((sum, s) => sum + (s.final_cost ?? 0), 0) * 100) / 100
      : null;

  let status: RouteCostStatus = "complete";
  if (missing === segments.length) status = "missing";
  else if (missing > 0) status = "partial";

  return { status, missing_segment_count: missing, total_final_cost: total };
}

/**
 * Sync persisted routes from Milestone 4 chain enumeration for an order.
 */
export async function syncOrderRoutesFromPreview(
  order: OrderResponse,
  liveChains?: RouteChain[]
): Promise<number[]> {
  const chains = liveChains ?? (await fetchLiveRouteChains(order));
  const routeIds: number[] = [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM order_routes WHERE order_id = $1`, [order.id]);

    for (let i = 0; i < chains.length; i++) {
      const chain = chains[i];
      const zoneMeta = await loadZoneMetaForIds(chain.zone_ids);
      const transporterIds = chain.zone_ids
        .map((zid) => zoneMeta.get(zid)?.owner_user_id)
        .filter((id): id is number => id != null);
      const uniqueTransporters = Array.from(new Set(transporterIds));

      const insert = await client.query(
        `INSERT INTO order_routes
           (order_id, route_label, route_index, zone_ids, connection_ids, transporter_ids, is_complete)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, TRUE)
         RETURNING id`,
        [
          order.id,
          `Route ${i + 1}`,
          i,
          JSON.stringify(chain.zone_ids),
          JSON.stringify(chain.connection_ids),
          JSON.stringify(uniqueTransporters),
        ]
      );
      routeIds.push(Number(insert.rows[0].id));
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return routeIds;
}

async function getOrderForCostAccess(
  orderId: number,
  ctx: OrderContext
): Promise<OrderResponse> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new RouteCostError("Order not found", 404);
  return order;
}

async function assertRouteAccess(
  routeId: number,
  ctx: OrderContext
): Promise<{ order: OrderResponse; route: Record<string, unknown> }> {
  const result = await pool.query(
    `SELECT r.*, o.sender_user_id, o.receiver_user_id
     FROM order_routes r
     JOIN orders o ON o.id = r.order_id
     WHERE r.id = $1`,
    [routeId]
  );
  if (result.rowCount === 0) throw new RouteCostError("Route not found", 404);
  const row = result.rows[0];

  const senderId = Number(row.sender_user_id);
  const receiverId = Number(row.receiver_user_id);
  const transporterIds = parseJsonIntArray(row.transporter_ids);

  if (ctx.role === "admin") {
    /* ok */
  } else if (ctx.role === "sender" && ctx.userId === senderId) {
    /* ok */
  } else if (ctx.role === "receiver" && ctx.userId === receiverId) {
    /* ok */
  } else if (ctx.role === "driver" && transporterIds.includes(ctx.userId)) {
    /* ok */
  } else {
    throw new RouteCostError("Forbidden", 403);
  }

  const order = await getOrderById(Number(row.order_id), ctx);
  if (!order) throw new RouteCostError("Order not found", 404);
  return { order, route: row };
}

export async function calculateRouteCost(
  routeId: number,
  ctx: OrderContext,
  preservedManualByZoneSig?: Map<string, number>
): Promise<RouteCostSummaryResponse> {
  const { order, route } = await assertRouteAccess(routeId, ctx);
  const zoneIds = parseJsonIntArray(route.zone_ids);
  const zoneMeta = await loadZoneMetaForIds(zoneIds);
  const zoneCoords = await loadZoneCentroids(zoneIds);
  const zoneRates = await loadZoneRates(zoneIds);
  const zoneLineDistances = await loadZoneLineDistances(zoneIds);
  const connectionIds = parseJsonIntArray(route.connection_ids);
  const connectionsById = await loadConnectionsByIds(connectionIds);
  const segments = deriveSegmentsFromRoute(zoneIds, zoneMeta);
  const segmentDistances = computeSegmentDistances(
    zoneIds,
    connectionIds,
    order,
    zoneMeta,
    zoneCoords,
    zoneLineDistances,
    connectionsById,
    segments
  );
  const sig = zoneSignature(zoneIds);

  // Preserve any manual cost a user already entered so a recalculation does
  // not silently wipe it. Keyed by segment_index, which is stable for a route.
  const preservedManual = new Map<number, number>();
  const existingSegs = await pool.query(
    `SELECT segment_index, manual_cost FROM route_segment_costs
     WHERE route_id = $1 AND cost_status = 'manual' AND manual_cost IS NOT NULL`,
    [routeId]
  );
  for (const row of existingSegs.rows) {
    preservedManual.set(Number(row.segment_index), Number(row.manual_cost));
  }
  // Manual costs snapshotted before a full-order recalc (route ids changed)
  // are keyed by zone signature; merge them in for this route.
  if (preservedManualByZoneSig) {
    for (const seg of segments) {
      const carried = preservedManualByZoneSig.get(`${sig}::${seg.segment_index}`);
      if (carried != null) preservedManual.set(seg.segment_index, carried);
    }
  }

  await pool.query(`DELETE FROM route_segment_costs WHERE route_id = $1`, [routeId]);

  const segmentRows: RouteSegmentCostResponse[] = [];
  let totalCalculated = 0;
  let totalManual = 0;
  let calculatedCount = 0;
  let manualCount = 0;

  for (const seg of segments) {
    // Rate comes from the segment's entry zone (the transporter set it there).
    const rate = seg.from_zone_id != null ? zoneRates.get(seg.from_zone_id) ?? null : null;
    const lineDistanceKm =
      seg.from_zone_id != null ? zoneLineDistances.get(seg.from_zone_id) ?? null : null;
    const cost = calculateSegmentCost({
      segment: seg,
      order,
      rate,
      zoneCoords,
      lineDistanceKm,
      distanceOverride: segmentDistances.get(seg.segment_index),
    });

    // Re-apply a preserved manual cost (takes precedence over a fresh calc).
    const preserved = preservedManual.get(seg.segment_index);
    if (preserved != null) {
      cost.manual_cost = preserved;
      cost.final_cost = preserved;
      cost.cost_status = "manual";
    }

    if (cost.cost_status === "calculated" && cost.calculated_cost != null) {
      totalCalculated += cost.calculated_cost;
      calculatedCount++;
    } else if (cost.cost_status === "manual" && cost.manual_cost != null) {
      totalManual += cost.manual_cost;
      manualCount++;
    }

    const insert = await pool.query(
      `INSERT INTO route_segment_costs
         (route_id, segment_index, transporter_id, from_node_id, to_node_id,
          transport_method, package_weight, package_volume,
          distance_h3_cells, distance_km,
          base_fee, weight_cost, volume_cost, distance_cost, time_factor_amount,
          calculated_cost, manual_cost, final_cost, cost_status, currency, calculation_breakdown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
       RETURNING id`,
      [
        routeId,
        seg.segment_index,
        seg.transporter_id,
        seg.from_node_id,
        seg.to_node_id,
        seg.transport_method,
        cost.package_weight,
        cost.package_volume,
        cost.distance_h3_cells,
        cost.distance_km,
        cost.base_fee,
        cost.weight_cost,
        cost.volume_cost,
        cost.distance_cost,
        cost.time_factor_amount,
        cost.calculated_cost,
        cost.manual_cost,
        cost.final_cost,
        cost.cost_status,
        cost.currency,
        cost.calculation_breakdown ? JSON.stringify(cost.calculation_breakdown) : null,
      ]
    );

    segmentRows.push(
      await buildSegmentResponse(insert.rows[0], zoneMeta, await loadTransporterNames([seg.transporter_id]))
    );
  }

  const summaryInput = segmentRows.map((s) => ({
    cost_status: s.cost_status,
    final_cost: s.final_cost,
  }));
  const { status, missing_segment_count, total_final_cost } = summarizeRouteStatus(summaryInput);

  await pool.query(`DELETE FROM route_cost_summaries WHERE route_id = $1`, [routeId]);
  await pool.query(
    `INSERT INTO route_cost_summaries
       (route_id, order_id, total_calculated_cost, total_manual_cost, total_final_cost,
        missing_segment_count, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      routeId,
      order.id,
      calculatedCount > 0 ? Math.round(totalCalculated * 100) / 100 : null,
      manualCount > 0 ? Math.round(totalManual * 100) / 100 : null,
      total_final_cost,
      missing_segment_count,
      segmentRows[0]?.currency ?? "CAD",
      status,
    ]
  );

  return buildRouteSummaryResponse(route, order, segmentRows);
}

async function buildSegmentResponse(
  row: Record<string, unknown>,
  zoneMeta: Map<number, { zone_name: string }>,
  transporterNames: Map<number, string>
): Promise<RouteSegmentCostResponse> {
  const zoneNames = new Map<number, string>();
  zoneMeta.forEach((v, k) => zoneNames.set(k, v.zone_name));

  let breakdown = null;
  if (row.calculation_breakdown) {
    breakdown =
      typeof row.calculation_breakdown === "string"
        ? JSON.parse(row.calculation_breakdown)
        : row.calculation_breakdown;
  }

  const tid = Number(row.transporter_id);
  return {
    segment_id: Number(row.id),
    segment_index: Number(row.segment_index),
    transporter_id: tid,
    transporter_name: transporterNames.get(tid) ?? `Transporter #${tid}`,
    from_node_id: String(row.from_node_id),
    from_label: nodeLabel(String(row.from_node_id), zoneNames),
    to_node_id: String(row.to_node_id),
    to_label: nodeLabel(String(row.to_node_id), zoneNames),
    transport_method: String(row.transport_method),
    distance_h3_cells: row.distance_h3_cells != null ? Number(row.distance_h3_cells) : null,
    distance_km: row.distance_km != null ? Number(row.distance_km) : null,
    base_fee: row.base_fee != null ? Number(row.base_fee) : null,
    distance_cost: row.distance_cost != null ? Number(row.distance_cost) : null,
    weight_cost: row.weight_cost != null ? Number(row.weight_cost) : null,
    volume_cost: row.volume_cost != null ? Number(row.volume_cost) : null,
    time_factor_amount: row.time_factor_amount != null ? Number(row.time_factor_amount) : null,
    calculated_cost: row.calculated_cost != null ? Number(row.calculated_cost) : null,
    manual_cost: row.manual_cost != null ? Number(row.manual_cost) : null,
    final_cost: row.final_cost != null ? Number(row.final_cost) : null,
    cost_status: String(row.cost_status) as SegmentCostStatus,
    currency: String(row.currency ?? "CAD"),
    breakdown,
  };
}

async function buildRouteSummaryResponse(
  route: Record<string, unknown>,
  order: OrderResponse,
  segments: RouteSegmentCostResponse[]
): Promise<RouteCostSummaryResponse> {
  const transporterIds = parseJsonIntArray(route.transporter_ids);
  const names = await loadTransporterNames(transporterIds);
  const transporters = transporterIds.map((id) => names.get(id) ?? `Transporter #${id}`);
  const { status, missing_segment_count, total_final_cost } = summarizeRouteStatus(segments);

  const summaryResult = await pool.query(
    `SELECT * FROM route_cost_summaries WHERE route_id = $1`,
    [Number(route.id)]
  );
  const summary = summaryResult.rows[0];

  return {
    route_id: Number(route.id),
    order_id: order.id,
    route_label: String(route.route_label ?? ""),
    transporters,
    segment_count: segments.length,
    total_calculated_cost: summary?.total_calculated_cost != null ? Number(summary.total_calculated_cost) : null,
    total_manual_cost: summary?.total_manual_cost != null ? Number(summary.total_manual_cost) : null,
    total_final_cost,
    missing_segment_count,
    currency: String(summary?.currency ?? segments[0]?.currency ?? "CAD"),
    status,
    segments,
  };
}

export async function getRouteCostSummary(
  routeId: number,
  ctx: OrderContext
): Promise<RouteCostSummaryResponse> {
  const { order, route } = await assertRouteAccess(routeId, ctx);

  const segResult = await pool.query(
    `SELECT * FROM route_segment_costs WHERE route_id = $1 ORDER BY segment_index`,
    [routeId]
  );

  const zoneIds = parseJsonIntArray(route.zone_ids);
  const zoneMeta = await loadZoneMetaForIds(zoneIds);

  // Recompute when there are no rows yet, when any segment is still "missing"
  // (so newly-set zone prices are picked up without pressing "Recalculate";
  // manual entries stay 'manual', not 'missing'), or when the stored
  // segmentation no longer matches the current per-zone derivation — which is
  // how older rows that merged several zones into one segment get rebuilt.
  const hasMissing = segResult.rows.some((r) => String(r.cost_status) === "missing");
  const expectedSegmentCount = deriveSegmentsFromRoute(zoneIds, zoneMeta).length;
  const segmentationStale = segResult.rowCount !== expectedSegmentCount;
  if (segResult.rowCount === 0 || hasMissing || segmentationStale) {
    return calculateRouteCost(routeId, ctx);
  }

  const transporterIds = segResult.rows.map((r) => Number(r.transporter_id));
  const names = await loadTransporterNames(transporterIds);

  const segments: RouteSegmentCostResponse[] = [];
  for (const row of segResult.rows) {
    segments.push(await buildSegmentResponse(row, zoneMeta, names));
  }

  return buildRouteSummaryResponse(route, order, segments);
}

export async function getRouteSegmentCosts(
  routeId: number,
  ctx: OrderContext
): Promise<RouteSegmentCostResponse[]> {
  const summary = await getRouteCostSummary(routeId, ctx);
  return summary.segments;
}

export async function applyManualSegmentCost(
  segmentCostId: number,
  manualCost: number,
  ctx: OrderContext
): Promise<RouteSegmentCostResponse> {
  const segResult = await pool.query(
    `SELECT sc.*, r.order_id, r.id AS route_id, r.transporter_ids, r.zone_ids
     FROM route_segment_costs sc
     JOIN order_routes r ON r.id = sc.route_id
     WHERE sc.id = $1`,
    [segmentCostId]
  );
  if (segResult.rowCount === 0) throw new RouteCostError("Segment cost not found", 404);
  const seg = segResult.rows[0];

  const transporterIds = parseJsonIntArray(seg.transporter_ids);
  if (ctx.role === "driver" && Number(seg.transporter_id) !== ctx.userId) {
    throw new RouteCostError("You can only enter manual cost for your own segments", 403);
  }
  if (ctx.role !== "admin" && ctx.role !== "driver") {
    throw new RouteCostError("Only admins and transporters can enter manual segment costs", 403);
  }

  await pool.query(
    `UPDATE route_segment_costs
     SET manual_cost = $2, final_cost = $2, cost_status = 'manual', updated_at = NOW()
     WHERE id = $1`,
    [segmentCostId, manualCost]
  );

  await recalculateRouteSummary(Number(seg.route_id));

  const zoneMeta = await loadZoneMetaForIds(parseJsonIntArray(seg.zone_ids));
  const names = await loadTransporterNames([Number(seg.transporter_id)]);
  const updated = await pool.query(`SELECT * FROM route_segment_costs WHERE id = $1`, [segmentCostId]);
  return buildSegmentResponse(updated.rows[0], zoneMeta, names);
}

async function recalculateRouteSummary(routeId: number): Promise<void> {
  const segResult = await pool.query(
    `SELECT cost_status, final_cost, calculated_cost, manual_cost, currency
     FROM route_segment_costs WHERE route_id = $1`,
    [routeId]
  );
  const segments = segResult.rows.map((r) => ({
    cost_status: String(r.cost_status) as SegmentCostStatus,
    final_cost: r.final_cost != null ? Number(r.final_cost) : null,
  }));

  let totalCalculated = 0;
  let totalManual = 0;
  let calcCount = 0;
  let manualCount = 0;
  for (const row of segResult.rows) {
    if (row.cost_status === "calculated" && row.calculated_cost != null) {
      totalCalculated += Number(row.calculated_cost);
      calcCount++;
    }
    if (row.cost_status === "manual" && row.manual_cost != null) {
      totalManual += Number(row.manual_cost);
      manualCount++;
    }
  }

  const { status, missing_segment_count, total_final_cost } = summarizeRouteStatus(segments);
  const routeResult = await pool.query(`SELECT order_id FROM order_routes WHERE id = $1`, [routeId]);
  const orderId = Number(routeResult.rows[0]?.order_id);

  await pool.query(
    `INSERT INTO route_cost_summaries
       (route_id, order_id, total_calculated_cost, total_manual_cost, total_final_cost,
        missing_segment_count, currency, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (route_id) DO UPDATE SET
       total_calculated_cost = EXCLUDED.total_calculated_cost,
       total_manual_cost = EXCLUDED.total_manual_cost,
       total_final_cost = EXCLUDED.total_final_cost,
       missing_segment_count = EXCLUDED.missing_segment_count,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [
      routeId,
      orderId,
      calcCount > 0 ? Math.round(totalCalculated * 100) / 100 : null,
      manualCount > 0 ? Math.round(totalManual * 100) / 100 : null,
      total_final_cost,
      missing_segment_count,
      String(segResult.rows[0]?.currency ?? "CAD"),
      status,
    ]
  );
}

async function resyncAndCostOrder(
  order: OrderResponse,
  ctx: OrderContext,
  liveChains?: RouteChain[]
): Promise<void> {
  const preservedManual = await snapshotManualCosts(order.id);
  const routeIds = await syncOrderRoutesFromPreview(order, liveChains);
  for (const routeId of routeIds) {
    await calculateRouteCost(routeId, ctx, preservedManual);
  }
}

async function buildOrderRouteComparison(
  orderId: number,
  ctx: OrderContext,
  liveChains?: RouteChain[]
): Promise<OrderRouteCostComparisonResponse> {
  const routesResult = await pool.query(
    `SELECT * FROM order_routes WHERE order_id = $1 ORDER BY route_index`,
    [orderId]
  );

  // Defensive: only ever surface routes that still exist in the *current* live
  // enumeration (the exact same set the Order page shows). This guarantees a
  // stale `order_routes` row can never leak into the comparison even if a
  // resync hasn't run yet, so both pages always list identical routes.
  const liveSigs = liveChains ? new Set(liveChains.map(chainSignature)) : null;
  const storedRows = liveSigs
    ? routesResult.rows.filter((r) => liveSigs.has(storedRouteSignature(r)))
    : routesResult.rows;

  const routes: RouteCostSummaryResponse[] = [];
  for (const route of storedRows) {
    routes.push(await getRouteCostSummary(Number(route.id), ctx));
  }

  routes.sort((a, b) => {
    if (a.total_final_cost == null && b.total_final_cost == null) return 0;
    if (a.total_final_cost == null) return 1;
    if (b.total_final_cost == null) return -1;
    return a.total_final_cost - b.total_final_cost;
  });

  const currency = routes[0]?.currency ?? "CAD";
  return { order_id: orderId, currency, routes };
}

export async function recalculateRouteCostsForOrder(
  orderId: number,
  ctx: OrderContext
): Promise<OrderRouteCostComparisonResponse> {
  const order = await getOrderForCostAccess(orderId, ctx);
  const liveChains = await withOrderResyncLock(order.id, async () => {
    const chains = await fetchLiveRouteChains(order);
    await resyncAndCostOrder(order, ctx, chains);
    return chains;
  });
  return buildOrderRouteComparison(orderId, ctx, liveChains);
}

export async function compareOrderRoutes(
  orderId: number,
  ctx: OrderContext
): Promise<OrderRouteCostComparisonResponse> {
  const order = await getOrderForCostAccess(orderId, ctx);

  let liveChains = await fetchLiveRouteChains(order);
  if (await orderRoutesNeedResync(order, liveChains)) {
    liveChains = await withOrderResyncLock(order.id, async () => {
      const freshChains = await fetchLiveRouteChains(order);
      if (await orderRoutesNeedResync(order, freshChains)) {
        await resyncAndCostOrder(order, ctx, freshChains);
      }
      return freshChains;
    });
  }

  return buildOrderRouteComparison(orderId, ctx, liveChains);
}

export async function markMissingCostSegments(routeId: number, ctx: OrderContext): Promise<void> {
  await getRouteCostSummary(routeId, ctx);
}
