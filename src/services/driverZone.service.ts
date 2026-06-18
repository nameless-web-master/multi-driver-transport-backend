import { pool } from "../database";
import { DEFAULT_CURRENCY, normalizeCurrency, type Currency } from "../models/currency.model";
import {
  DriverZoneCreateInput,
  DriverZoneRow,
  DriverZoneUpdateInput,
  HubTerminal,
  LatLngPoint,
} from "../models/driverZone.model";
import type { TransportMode } from "../models/transportMode.model";
import type { UserRole } from "../models/userRole.model";
import {
  CreateDriverZoneRequest,
  DriverZoneResponse,
  UpdateDriverZoneRequest,
} from "../schemas/driverZone.schema";
import { cellResolution, pointToCell, polygonCells, sanitizeCells } from "./h3_service";
import type { H3Resolution, LatLng } from "./h3_service";
import {
  deactivateConnectionsForZone,
  recalculateConnectionsForZone,
} from "./zoneConnection.service";

const ZONE_SELECT = `
  SELECT z.id, z.owner_user_id, z.driver_name, z.zone_name, z.resolution, z.h3_cells,
         z.transport_mode, z.boundary,
         z.departure_hub_name, z.departure_hub_lat, z.departure_hub_lng,
         z.arrival_hub_name, z.arrival_hub_lat, z.arrival_hub_lng,
         z.departure_time, z.arrival_time,
         z.base_fee, z.cost_per_h3_cell, z.cost_per_km, z.cost_per_hour, z.cost_per_kg,
         z.cost_per_volume_unit, z.time_of_day_factor, z.minimum_fee,
         z.currency, z.available, z.trust_payment_forwarder,
         z.created_at, z.updated_at,
         COALESCE(u.trustworthiness, 0) AS driver_trustworthiness
  FROM driver_zones z
  LEFT JOIN users u ON u.id = z.owner_user_id
`;

function isHubTransportMode(mode: string): boolean {
  return mode === "air" || mode === "sea";
}

/** Coerce a DB numeric (string|null) to number|null. */
function toNullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseHubFromRow(
  row: Record<string, unknown>,
  prefix: "departure" | "arrival"
): HubTerminal | null {
  const name = row[`${prefix}_hub_name`];
  const lat = row[`${prefix}_hub_lat`];
  const lng = row[`${prefix}_hub_lng`];
  if (name == null || lat == null || lng == null) return null;
  const latN = Number(lat);
  const lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return null;
  const nameStr = String(name).trim();
  if (!nameStr) return null;
  return { name: nameStr, lat: latN, lng: lngN };
}

function rowToResponse(row: DriverZoneRow & { driver_trustworthiness?: number }): DriverZoneResponse {
  const cells = Array.isArray(row.h3_cells) ? row.h3_cells : [];
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    driver_name: row.driver_name,
    zone_name: row.zone_name,
    resolution: row.resolution,
    h3_cells: cells,
    cell_count: cells.length,
    transport_mode: row.transport_mode,
    boundary: row.boundary,
    departure_hub: row.departure_hub,
    arrival_hub: row.arrival_hub,
    departure_time: row.departure_time,
    arrival_time: row.arrival_time,
    base_fee: row.base_fee,
    cost_per_h3_cell: row.cost_per_h3_cell,
    cost_per_km: row.cost_per_km,
    cost_per_hour: row.cost_per_hour,
    cost_per_kg: row.cost_per_kg,
    cost_per_volume_unit: row.cost_per_volume_unit,
    time_of_day_factor: row.time_of_day_factor,
    minimum_fee: row.minimum_fee,
    currency: row.currency,
    available: row.available,
    trust_payment_forwarder: row.trust_payment_forwarder,
    driver_trustworthiness: row.driver_trustworthiness ?? 0,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function parseBoundary(raw: unknown): LatLngPoint[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const pts = raw
      .map((p) => {
        if (p && typeof p === "object" && "lat" in p && "lng" in p) {
          return { lat: Number((p as LatLngPoint).lat), lng: Number((p as LatLngPoint).lng) };
        }
        return null;
      })
      .filter((p): p is LatLngPoint => p !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    return pts.length >= 3 ? pts : null;
  }
  if (typeof raw === "string") {
    try {
      return parseBoundary(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return null;
}

function parseRow(row: Record<string, unknown>): DriverZoneRow & { driver_trustworthiness?: number } {
  const rawCells = row.h3_cells;
  let h3_cells: string[] = [];
  if (Array.isArray(rawCells)) {
    h3_cells = rawCells.map(String);
  } else if (typeof rawCells === "string") {
    try {
      h3_cells = JSON.parse(rawCells);
    } catch {
      h3_cells = [];
    }
  }

  const modeRaw = String(row.transport_mode ?? "land").toLowerCase();
  const transport_mode: TransportMode =
    modeRaw === "air" || modeRaw === "sea" ? (modeRaw as TransportMode) : "land";

  return {
    id: Number(row.id),
    owner_user_id: Number(row.owner_user_id),
    driver_name: String(row.driver_name),
    zone_name: String(row.zone_name),
    resolution: Number(row.resolution),
    h3_cells,
    transport_mode,
    boundary: parseBoundary(row.boundary),
    departure_hub: parseHubFromRow(row, "departure"),
    arrival_hub: parseHubFromRow(row, "arrival"),
    departure_time: row.departure_time == null ? null : String(row.departure_time),
    arrival_time: row.arrival_time == null ? null : String(row.arrival_time),
    base_fee: toNullableNum(row.base_fee),
    cost_per_h3_cell: toNullableNum(row.cost_per_h3_cell),
    cost_per_km: toNullableNum(row.cost_per_km),
    cost_per_hour: toNullableNum(row.cost_per_hour),
    cost_per_kg: toNullableNum(row.cost_per_kg),
    cost_per_volume_unit: toNullableNum(row.cost_per_volume_unit),
    time_of_day_factor: toNullableNum(row.time_of_day_factor),
    minimum_fee: toNullableNum(row.minimum_fee),
    currency: normalizeCurrency(row.currency),
    available: Boolean(row.available ?? true),
    trust_payment_forwarder: Boolean(row.trust_payment_forwarder ?? false),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
    driver_trustworthiness: Number(row.driver_trustworthiness ?? 0),
  };
}

function validateCells(rawCells: string[], resolution: number): string[] {
  const { valid, invalid } = sanitizeCells(rawCells);
  if (invalid.length > 0) {
    throw new Error(
      `Invalid H3 cells: ${invalid.slice(0, 3).join(", ")}${invalid.length > 3 ? "…" : ""}`
    );
  }
  if (valid.length === 0) {
    throw new Error("No H3 cells provided");
  }
  const mismatched = valid.find((c) => cellResolution(c) !== resolution);
  if (mismatched) {
    throw new Error(
      `Cell ${mismatched} has resolution ${cellResolution(mismatched)}, expected ${resolution}`
    );
  }
  return valid;
}

/**
 * Compute H3 cells covering a geofence polygon at the given resolution.
 *
 * `polygonToCells` only includes cells whose *centers* fall inside the
 * polygon, so tiny / narrow geofences (or polygons drawn at a too-fine
 * resolution) can legitimately return 0 cells. Rejecting the request in
 * that case used to break "update geofence" silently from the driver's
 * perspective — the front-end just surfaces "no H3 cells at this
 * resolution" with no way to recover.
 *
 * Fallback strategy: when the strict fill is empty, materialize one cell
 * per polygon vertex plus the cell containing the centroid. That always
 * produces at least one cell, lets the update succeed, and stays at the
 * requested resolution so `validateCells` is happy downstream.
 */
function cellsFromGeofence(
  boundary: LatLngPoint[],
  resolution: H3Resolution
): string[] {
  let cells: string[] = [];
  try {
    cells = polygonCells(boundary, resolution);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    throw new Error(`Invalid geofence boundary (h3 error: ${msg})`);
  }
  if (cells.length > 0) return cells;

  const seen = new Set<string>();
  const fallback: string[] = [];
  let latSum = 0;
  let lngSum = 0;
  for (const p of boundary) {
    latSum += p.lat;
    lngSum += p.lng;
    try {
      const c = pointToCell(p.lat, p.lng, resolution);
      if (!seen.has(c)) {
        seen.add(c);
        fallback.push(c);
      }
    } catch {
      /* ignore invalid vertex; remaining vertices may still resolve */
    }
  }
  try {
    const centroid: LatLng = {
      lat: latSum / boundary.length,
      lng: lngSum / boundary.length,
    };
    const c = pointToCell(centroid.lat, centroid.lng, resolution);
    if (!seen.has(c)) {
      seen.add(c);
      fallback.push(c);
    }
  } catch {
    /* centroid out of range — vertex cells (if any) still apply */
  }

  if (fallback.length === 0) {
    throw new Error("Geofence boundary produced no H3 cells at this resolution");
  }
  return fallback;
}

/**
 * Derive minimal H3 cells from hub terminal coordinates so the connection
 * graph can still reference this zone. One cell per hub at the given resolution.
 */
function cellsFromHubs(
  departure: HubTerminal,
  arrival: HubTerminal,
  resolution: H3Resolution
): string[] {
  const seen = new Set<string>();
  const cells: string[] = [];
  for (const hub of [departure, arrival]) {
    try {
      const c = pointToCell(hub.lat, hub.lng, resolution);
      if (!seen.has(c)) {
        seen.add(c);
        cells.push(c);
      }
    } catch {
      throw new Error(`Hub "${hub.name}" coordinates are out of range for H3`);
    }
  }
  if (cells.length === 0) {
    throw new Error("Could not resolve H3 cells from hub coordinates");
  }
  return cells;
}

function resolveCellsFromInput(
  resolution: number,
  h3_cells?: string[],
  boundary?: LatLngPoint[] | null,
  transportMode?: TransportMode,
  departureHub?: HubTerminal | null,
  arrivalHub?: HubTerminal | null
): { cells: string[]; boundary: LatLngPoint[] | null } {
  const hubRoute =
    (transportMode && isHubTransportMode(transportMode)) ||
    (!!departureHub && !!arrivalHub);
  if (hubRoute) {
    if (!departureHub || !arrivalHub) {
      throw new Error("departure_hub and arrival_hub are required for air/sea routes");
    }
    const cells = cellsFromHubs(departureHub, arrivalHub, resolution as H3Resolution);
    return { cells: validateCells(cells, resolution), boundary: null };
  }
  if (boundary && boundary.length >= 3) {
    const cells = cellsFromGeofence(boundary, resolution as H3Resolution);
    return { cells: validateCells(cells, resolution), boundary };
  }
  if (!h3_cells || h3_cells.length === 0) {
    throw new Error("Provide h3_cells or a geofence boundary");
  }
  return { cells: validateCells(h3_cells, resolution), boundary: null };
}

/**
 * True iff two boundaries describe the same polygon (same vertex count,
 * same lat/lng in the same order, within a tiny epsilon to absorb the
 * inevitable JSON round-trip noise). Used by the update path to short-
 * circuit the expensive `polygonToCells` recompute when a driver edits a
 * metadata-only field (name, rate, availability) on a geofence zone.
 *
 * Without this, a rename on a 60k-cell zone re-runs the polygon fill and
 * re-writes ~1 MB of JSONB on every save — easily blowing past the 15 s
 * `statement_timeout` and presenting as "geofence update doesn't work"
 * even though H3-cells zones (which skip the recompute) edit fine.
 */
function boundariesEqual(
  a: LatLngPoint[] | null | undefined,
  b: LatLngPoint[] | null | undefined
): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const eps = 1e-9;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].lat - b[i].lat) > eps) return false;
    if (Math.abs(a[i].lng - b[i].lng) > eps) return false;
  }
  return true;
}

export interface ZoneAccessContext {
  userId: number;
  role: UserRole;
}

export interface ListDriverZonesOptions {
  /** Sender/receiver: only see zones marked available. Driver/admin: see all. */
  availableOnly?: boolean;
  ownerUserId?: number;
}

function isPrivilegedRole(role: UserRole): boolean {
  return role === "admin";
}

export async function listDriverZones(
  ctx: ZoneAccessContext,
  options: ListDriverZonesOptions = {}
): Promise<DriverZoneResponse[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  // Drivers only ever see their own zones. Senders/Receivers see all.
  if (ctx.role === "driver") {
    params.push(ctx.userId);
    conditions.push(`z.owner_user_id = $${params.length}`);
  } else if (options.ownerUserId) {
    params.push(options.ownerUserId);
    conditions.push(`z.owner_user_id = $${params.length}`);
  }

  if (options.availableOnly) {
    conditions.push(`z.available = TRUE`);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(
    `${ZONE_SELECT} ${whereSql} ORDER BY z.created_at DESC`,
    params
  );
  return result.rows.map((r) => rowToResponse(parseRow(r)));
}

export async function getDriverZoneById(
  id: number,
  ctx: ZoneAccessContext
): Promise<DriverZoneResponse | null> {
  const params: unknown[] = [id];
  let extra = "";
  if (ctx.role === "driver") {
    params.push(ctx.userId);
    extra = ` AND z.owner_user_id = $${params.length}`;
  }
  const result = await pool.query(
    `${ZONE_SELECT} WHERE z.id = $1${extra}`,
    params
  );
  if (result.rowCount === 0) return null;
  return rowToResponse(parseRow(result.rows[0]));
}

export async function createDriverZone(
  input: DriverZoneCreateInput
): Promise<DriverZoneResponse> {
  const { cells, boundary } = resolveCellsFromInput(
    input.resolution,
    input.h3_cells,
    input.boundary,
    input.transport_mode,
    input.departure_hub,
    input.arrival_hub
  );

  const result = await pool.query(
    `INSERT INTO driver_zones
       (owner_user_id, driver_name, zone_name, resolution, h3_cells, transport_modes, transport_mode,
        boundary,
        departure_hub_name, departure_hub_lat, departure_hub_lng,
        arrival_hub_name, arrival_hub_lat, arrival_hub_lng,
        departure_time, arrival_time,
        base_fee, cost_per_h3_cell, cost_per_km, cost_per_hour, cost_per_kg,
        cost_per_volume_unit, time_of_day_factor, minimum_fee,
        currency, available, trust_payment_forwarder)
     VALUES ($1, $2, $3, $4, $5::jsonb, ARRAY[$6]::TEXT[], $6, $7::jsonb,
             $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22, $23,
             $24, $25, $26)
     RETURNING id`,
    [
      input.owner_user_id,
      input.driver_name,
      input.zone_name,
      input.resolution,
      JSON.stringify(cells),
      input.transport_mode,
      boundary ? JSON.stringify(boundary) : null,
      input.departure_hub?.name ?? null,
      input.departure_hub?.lat ?? null,
      input.departure_hub?.lng ?? null,
      input.arrival_hub?.name ?? null,
      input.arrival_hub?.lat ?? null,
      input.arrival_hub?.lng ?? null,
      input.departure_time ?? null,
      input.arrival_time ?? null,
      input.base_fee ?? null,
      input.cost_per_h3_cell ?? null,
      input.cost_per_km ?? null,
      input.cost_per_hour ?? null,
      input.cost_per_kg ?? null,
      input.cost_per_volume_unit ?? null,
      input.time_of_day_factor ?? null,
      input.minimum_fee ?? null,
      normalizeCurrency(input.currency),
      input.available,
      input.trust_payment_forwarder,
    ]
  );

  const id = Number(result.rows[0].id);
  const created = await getDriverZoneById(id, { userId: input.owner_user_id, role: "driver" });
  if (!created) throw new Error("Failed to load freshly created zone");

  // Refresh the M2 zone-connection graph in the background. Best-effort:
  // failure here should not roll back the zone creation.
  recalculateConnectionsForZone(id).catch((err) =>
    console.error("[zone-connections] recalc after create failed:", err)
  );

  return created;
}

export async function createDriverZoneFromRequest(
  ownerUserId: number,
  data: CreateDriverZoneRequest
): Promise<DriverZoneResponse> {
  const { cells, boundary } = resolveCellsFromInput(
    data.resolution,
    data.h3_cells,
    data.boundary,
    data.transport_mode,
    data.departure_hub,
    data.arrival_hub
  );
  return createDriverZone({
    owner_user_id: ownerUserId,
    driver_name: data.driver_name,
    zone_name: data.zone_name,
    resolution: data.resolution,
    h3_cells: cells,
    transport_mode: data.transport_mode,
    boundary,
    departure_hub: data.departure_hub ?? null,
    arrival_hub: data.arrival_hub ?? null,
    departure_time: data.departure_time ?? null,
    arrival_time: data.arrival_time ?? null,
    base_fee: data.base_fee ?? null,
    cost_per_h3_cell: data.cost_per_h3_cell ?? null,
    cost_per_km: data.cost_per_km ?? null,
    cost_per_hour: data.cost_per_hour ?? null,
    cost_per_kg: data.cost_per_kg ?? null,
    cost_per_volume_unit: data.cost_per_volume_unit ?? null,
    time_of_day_factor: data.time_of_day_factor ?? null,
    minimum_fee: data.minimum_fee ?? null,
    currency: normalizeCurrency(data.currency ?? DEFAULT_CURRENCY),
    available: data.available,
    trust_payment_forwarder: data.trust_payment_forwarder,
  });
}

export async function updateDriverZone(
  id: number,
  ctx: ZoneAccessContext,
  input: DriverZoneUpdateInput
): Promise<DriverZoneResponse | null> {
  const existing = await getDriverZoneById(id, ctx);
  if (!existing) return null;

  const driver_name = input.driver_name ?? existing.driver_name;
  const zone_name = input.zone_name ?? existing.zone_name;
  const resolution = input.resolution ?? existing.resolution;
  const transport_mode = (input.transport_mode ?? existing.transport_mode) as TransportMode;
  const base_fee = input.base_fee !== undefined ? input.base_fee : existing.base_fee;
  const cost_per_h3_cell =
    input.cost_per_h3_cell !== undefined ? input.cost_per_h3_cell : existing.cost_per_h3_cell;
  const cost_per_km = input.cost_per_km !== undefined ? input.cost_per_km : existing.cost_per_km;
  const cost_per_hour =
    input.cost_per_hour !== undefined ? input.cost_per_hour : existing.cost_per_hour;
  const cost_per_kg = input.cost_per_kg !== undefined ? input.cost_per_kg : existing.cost_per_kg;
  const cost_per_volume_unit =
    input.cost_per_volume_unit !== undefined
      ? input.cost_per_volume_unit
      : existing.cost_per_volume_unit;
  const time_of_day_factor =
    input.time_of_day_factor !== undefined ? input.time_of_day_factor : existing.time_of_day_factor;
  const minimum_fee = input.minimum_fee !== undefined ? input.minimum_fee : existing.minimum_fee;
  const currency: Currency = normalizeCurrency(input.currency ?? existing.currency);
  const available = input.available ?? existing.available;
  const trust_payment_forwarder =
    input.trust_payment_forwarder ?? existing.trust_payment_forwarder;
  const departure_hub =
    input.departure_hub !== undefined ? input.departure_hub : existing.departure_hub;
  const arrival_hub =
    input.arrival_hub !== undefined ? input.arrival_hub : existing.arrival_hub;
  const departure_time =
    input.departure_time !== undefined ? input.departure_time : existing.departure_time;
  const arrival_time =
    input.arrival_time !== undefined ? input.arrival_time : existing.arrival_time;

  let h3_cells = input.h3_cells ?? existing.h3_cells;
  let boundary: LatLngPoint[] | null =
    input.boundary !== undefined ? input.boundary : existing.boundary;
  /**
   * Whether the H3 cell list actually needs to change. Defaults to true to
   * match the historical behaviour, but the geofence branch below sets it
   * to false when the polygon + resolution are identical to what's stored
   * (the common "rename geofence zone" case). Skipping the cell rewrite
   * then keeps the UPDATE light — critical for zones with tens of
   * thousands of cells where re-serializing the JSONB blob would otherwise
   * push us past the 15 s statement_timeout and surface to the driver as
   * "geofence won't update".
   */
  let cellsChanged = true;

  if (isHubTransportMode(transport_mode)) {
    if (!departure_hub || !arrival_hub) {
      throw new Error("departure_hub and arrival_hub are required for air/sea routes");
    }
    const hubsChanged =
      input.departure_hub !== undefined ||
      input.arrival_hub !== undefined ||
      input.transport_mode !== undefined ||
      resolution !== existing.resolution;
    if (hubsChanged) {
      const resolved = resolveCellsFromInput(
        resolution,
        undefined,
        null,
        transport_mode,
        departure_hub,
        arrival_hub
      );
      h3_cells = resolved.cells;
      boundary = null;
    } else {
      h3_cells = existing.h3_cells;
      cellsChanged = false;
    }
  } else if (input.boundary && input.boundary.length >= 3) {
    const sameBoundary = boundariesEqual(input.boundary, existing.boundary);
    const sameResolution = resolution === existing.resolution;
    if (sameBoundary && sameResolution && existing.h3_cells.length > 0) {
      // Polygon + resolution unchanged → reuse the existing fill.
      h3_cells = existing.h3_cells;
      boundary = input.boundary;
      cellsChanged = false;
    } else {
      const resolved = resolveCellsFromInput(resolution, undefined, input.boundary);
      h3_cells = resolved.cells;
      boundary = resolved.boundary;
    }
  } else if (input.h3_cells) {
    h3_cells = validateCells(input.h3_cells, resolution);
    if (input.boundary === null) boundary = null;
  } else {
    h3_cells = validateCells(h3_cells, resolution);
    cellsChanged = false;
  }

  const params: unknown[] = [
    driver_name,
    zone_name,
    resolution,
    transport_mode,
    boundary ? JSON.stringify(boundary) : null,
    departure_hub?.name ?? null,
    departure_hub?.lat ?? null,
    departure_hub?.lng ?? null,
    arrival_hub?.name ?? null,
    arrival_hub?.lat ?? null,
    arrival_hub?.lng ?? null,
    departure_time,
    arrival_time,
    base_fee,
    cost_per_h3_cell,
    cost_per_km,
    cost_per_hour,
    cost_per_kg,
    cost_per_volume_unit,
    time_of_day_factor,
    minimum_fee,
    currency,
    available,
    trust_payment_forwarder,
  ];

  // When the geometry didn't change we leave h3_cells alone. Writing a
  // ~1 MB JSONB blob back for a zone with 60k cells is what was tipping
  // metadata-only edits past the statement_timeout (manifesting as "the
  // driver can't update a geofence zone").
  let cellsSql = "";
  if (cellsChanged) {
    params.push(JSON.stringify(h3_cells));
    cellsSql = `, h3_cells = $${params.length}::jsonb`;
  }

  params.push(id);
  const idParamIdx = params.length;

  let ownerClause = "";
  if (ctx.role === "driver") {
    params.push(ctx.userId);
    ownerClause = ` AND owner_user_id = $${params.length}`;
  } else if (!isPrivilegedRole(ctx.role)) {
    return null;
  }

  const result = await pool.query(
    `UPDATE driver_zones
       SET driver_name = $1, zone_name = $2, resolution = $3,
           transport_mode = $4, transport_modes = ARRAY[$4]::TEXT[],
           boundary = $5::jsonb,
           departure_hub_name = $6, departure_hub_lat = $7, departure_hub_lng = $8,
           arrival_hub_name = $9, arrival_hub_lat = $10, arrival_hub_lng = $11,
           departure_time = $12, arrival_time = $13,
           base_fee = $14, cost_per_h3_cell = $15, cost_per_km = $16,
           cost_per_hour = $17, cost_per_kg = $18, cost_per_volume_unit = $19,
           time_of_day_factor = $20, minimum_fee = $21,
           currency = $22, available = $23, trust_payment_forwarder = $24,
           updated_at = NOW()${cellsSql}
     WHERE id = $${idParamIdx}${ownerClause}
     RETURNING id`,
    params
  );

  if (result.rowCount === 0) return null;

  const availabilityChanged =
    input.available !== undefined && input.available !== existing.available;

  // Geometry / availability may have changed — refresh connections for
  // this zone only (cheap incremental update, runs in the background).
  // Skip when only metadata changed: the front-end always includes
  // `available` in the payload even when it didn't change, so we must
  // compare against the stored value rather than checking `!== undefined`.
  if (cellsChanged || availabilityChanged) {
    recalculateConnectionsForZone(id).catch((err) =>
      console.error("[zone-connections] recalc after update failed:", err)
    );
  }

  // Avoid re-loading a multi-megabyte h3_cells blob when nothing geometric
  // changed — that second SELECT was adding several seconds to every
  // metadata edit on large geofence zones.
  if (!cellsChanged) {
    return {
      ...existing,
      driver_name,
      zone_name,
      resolution,
      transport_mode,
      departure_hub,
      arrival_hub,
      departure_time,
      arrival_time,
      base_fee,
      cost_per_h3_cell,
      cost_per_km,
      cost_per_hour,
      cost_per_kg,
      cost_per_volume_unit,
      time_of_day_factor,
      minimum_fee,
      currency,
      available,
      trust_payment_forwarder,
      boundary,
      updated_at: new Date().toISOString(),
    };
  }

  return getDriverZoneById(id, ctx);
}

export async function updateDriverZoneFromRequest(
  id: number,
  ctx: ZoneAccessContext,
  data: UpdateDriverZoneRequest
): Promise<DriverZoneResponse | null> {
  return updateDriverZone(id, ctx, {
    driver_name: data.driver_name,
    zone_name: data.zone_name,
    resolution: data.resolution,
    h3_cells: data.h3_cells,
    transport_mode: data.transport_mode,
    boundary: data.boundary,
    departure_hub: data.departure_hub,
    arrival_hub: data.arrival_hub,
    departure_time: data.departure_time,
    arrival_time: data.arrival_time,
    base_fee: data.base_fee,
    cost_per_h3_cell: data.cost_per_h3_cell,
    cost_per_km: data.cost_per_km,
    cost_per_hour: data.cost_per_hour,
    cost_per_kg: data.cost_per_kg,
    cost_per_volume_unit: data.cost_per_volume_unit,
    time_of_day_factor: data.time_of_day_factor,
    minimum_fee: data.minimum_fee,
    currency: data.currency,
    available: data.available,
    trust_payment_forwarder: data.trust_payment_forwarder,
  });
}

export async function deleteDriverZone(id: number, ctx: ZoneAccessContext): Promise<boolean> {
  const existing = await getDriverZoneById(id, ctx);
  if (!existing) return false;

  // Drop connections first so the recalc/visibility view never lags behind
  // the actual deletion (ON DELETE CASCADE would also catch them, but
  // doing it explicitly keeps callers race-free).
  await deactivateConnectionsForZone(id).catch((err) =>
    console.error("[zone-connections] cleanup before delete failed:", err)
  );

  if (ctx.role === "admin") {
    const result = await pool.query(`DELETE FROM driver_zones WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  if (ctx.role !== "driver") return false;

  const result = await pool.query(
    `DELETE FROM driver_zones WHERE id = $1 AND owner_user_id = $2`,
    [id, ctx.userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export class ZoneAvailabilityError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Admin-only: set `available` on every zone owned by a transporter. */
export async function setOwnerZonesAvailability(
  ownerUserId: number,
  available: boolean,
  ctx: ZoneAccessContext
): Promise<{ updated_count: number }> {
  if (ctx.role !== "admin") {
    throw new ZoneAvailabilityError(
      "Only admins can bulk-update transporter zone availability",
      403
    );
  }

  const userCheck = await pool.query(`SELECT id, role FROM users WHERE id = $1`, [ownerUserId]);
  if ((userCheck.rowCount ?? 0) === 0) {
    throw new ZoneAvailabilityError("Transporter not found", 404);
  }
  if (userCheck.rows[0].role !== "driver") {
    throw new ZoneAvailabilityError("User is not a transporter", 400);
  }

  const result = await pool.query(
    `UPDATE driver_zones SET available = $2, updated_at = NOW() WHERE owner_user_id = $1 RETURNING id`,
    [ownerUserId, available]
  );
  const zoneIds = result.rows.map((row) => Number(row.id));

  for (const zoneId of zoneIds) {
    recalculateConnectionsForZone(zoneId).catch((err) =>
      console.error("[zone-connections] recalc after bulk availability failed:", err)
    );
  }

  return { updated_count: zoneIds.length };
}
