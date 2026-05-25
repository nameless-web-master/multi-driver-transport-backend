import { pool } from "../database";
import { DEFAULT_CURRENCY, normalizeCurrency, type Currency } from "../models/currency.model";
import {
  DriverZoneCreateInput,
  DriverZoneRow,
  DriverZoneUpdateInput,
  LatLngPoint,
} from "../models/driverZone.model";
import type { TransportMode } from "../models/transportMode.model";
import type { UserRole } from "../models/userRole.model";
import {
  CreateDriverZoneRequest,
  DriverZoneResponse,
  UpdateDriverZoneRequest,
} from "../schemas/driverZone.schema";
import { cellResolution, polygonCells, sanitizeCells } from "./h3_service";
import type { H3Resolution } from "./h3_service";
import {
  deactivateConnectionsForZone,
  recalculateConnectionsForZone,
} from "./zoneConnection.service";

const ZONE_SELECT = `
  SELECT z.id, z.owner_user_id, z.driver_name, z.zone_name, z.resolution, z.h3_cells,
         z.transport_mode, z.boundary, z.rate_cost, z.currency, z.available, z.trust_payment_forwarder,
         z.created_at, z.updated_at,
         COALESCE(u.trustworthiness, 0) AS driver_trustworthiness
  FROM driver_zones z
  LEFT JOIN users u ON u.id = z.owner_user_id
`;

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
    rate_cost: row.rate_cost,
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
    rate_cost: Number(row.rate_cost ?? 0),
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

function resolveCellsFromInput(
  resolution: number,
  h3_cells?: string[],
  boundary?: LatLngPoint[] | null
): { cells: string[]; boundary: LatLngPoint[] | null } {
  if (boundary && boundary.length >= 3) {
    const cells = polygonCells(boundary, resolution as H3Resolution);
    if (cells.length === 0) {
      throw new Error("Geofence boundary produced no H3 cells at this resolution");
    }
    return { cells: validateCells(cells, resolution), boundary };
  }
  if (!h3_cells || h3_cells.length === 0) {
    throw new Error("Provide h3_cells or a geofence boundary");
  }
  return { cells: validateCells(h3_cells, resolution), boundary: null };
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
    input.boundary
  );

  const result = await pool.query(
    `INSERT INTO driver_zones
       (owner_user_id, driver_name, zone_name, resolution, h3_cells, transport_modes, transport_mode,
        boundary, rate_cost, currency, available, trust_payment_forwarder)
     VALUES ($1, $2, $3, $4, $5::jsonb, ARRAY[$6]::TEXT[], $6, $7::jsonb, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.owner_user_id,
      input.driver_name,
      input.zone_name,
      input.resolution,
      JSON.stringify(cells),
      input.transport_mode,
      boundary ? JSON.stringify(boundary) : null,
      input.rate_cost,
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
  const { cells, boundary } = resolveCellsFromInput(data.resolution, data.h3_cells, data.boundary);
  return createDriverZone({
    owner_user_id: ownerUserId,
    driver_name: data.driver_name,
    zone_name: data.zone_name,
    resolution: data.resolution,
    h3_cells: cells,
    transport_mode: data.transport_mode,
    boundary,
    rate_cost: data.rate_cost,
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
  const rate_cost = input.rate_cost ?? existing.rate_cost;
  const currency: Currency = normalizeCurrency(input.currency ?? existing.currency);
  const available = input.available ?? existing.available;
  const trust_payment_forwarder =
    input.trust_payment_forwarder ?? existing.trust_payment_forwarder;

  let h3_cells = input.h3_cells ?? existing.h3_cells;
  let boundary: LatLngPoint[] | null =
    input.boundary !== undefined ? input.boundary : existing.boundary;

  if (input.boundary && input.boundary.length >= 3) {
    const resolved = resolveCellsFromInput(resolution, undefined, input.boundary);
    h3_cells = resolved.cells;
    boundary = resolved.boundary;
  } else if (input.h3_cells) {
    h3_cells = validateCells(input.h3_cells, resolution);
    if (input.boundary === null) boundary = null;
  } else {
    h3_cells = validateCells(h3_cells, resolution);
  }

  const params: unknown[] = [
    driver_name,
    zone_name,
    resolution,
    JSON.stringify(h3_cells),
    transport_mode,
    boundary ? JSON.stringify(boundary) : null,
    rate_cost,
    currency,
    available,
    trust_payment_forwarder,
    id,
  ];

  let ownerClause = "";
  if (ctx.role === "driver") {
    params.push(ctx.userId);
    ownerClause = ` AND owner_user_id = $${params.length}`;
  } else if (!isPrivilegedRole(ctx.role)) {
    return null;
  }

  const result = await pool.query(
    `UPDATE driver_zones
       SET driver_name = $1, zone_name = $2, resolution = $3, h3_cells = $4::jsonb,
           transport_mode = $5, transport_modes = ARRAY[$5]::TEXT[],
           boundary = $6::jsonb, rate_cost = $7, currency = $8,
           available = $9, trust_payment_forwarder = $10,
           updated_at = NOW()
     WHERE id = $11${ownerClause}
     RETURNING id`,
    params
  );

  if (result.rowCount === 0) return null;

  // Geometry / availability may have changed — refresh connections for
  // this zone only (cheap incremental update, runs in the background).
  recalculateConnectionsForZone(id).catch((err) =>
    console.error("[zone-connections] recalc after update failed:", err)
  );

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
    rate_cost: data.rate_cost,
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
