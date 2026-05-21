import { pool } from "../database";
import {
  DriverZoneCreateInput,
  DriverZoneRow,
  DriverZoneUpdateInput,
} from "../models/driverZone.model";
import { DriverZoneResponse } from "../schemas/driverZone.schema";
import { cellResolution, sanitizeCells } from "./h3_service";

function rowToResponse(row: DriverZoneRow): DriverZoneResponse {
  const cells = Array.isArray(row.h3_cells) ? row.h3_cells : [];
  return {
    id: row.id,
    driver_name: row.driver_name,
    zone_name: row.zone_name,
    resolution: row.resolution,
    h3_cells: cells,
    cell_count: cells.length,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function parseRow(row: Record<string, unknown>): DriverZoneRow {
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
  return {
    id: Number(row.id),
    driver_name: String(row.driver_name),
    zone_name: String(row.zone_name),
    resolution: Number(row.resolution),
    h3_cells,
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

/**
 * Validates incoming H3 cell IDs against the requested resolution.
 * Returns deduped, normalized cells. Throws (with a descriptive message)
 * on invalid IDs or resolution mismatches – callers should NOT pre-filter.
 */
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

export async function listDriverZones(): Promise<DriverZoneResponse[]> {
  const result = await pool.query(
    `SELECT id, driver_name, zone_name, resolution, h3_cells, created_at, updated_at
     FROM driver_zones
     ORDER BY created_at DESC`
  );
  return result.rows.map((r) => rowToResponse(parseRow(r)));
}

export async function getDriverZoneById(id: number): Promise<DriverZoneResponse | null> {
  const result = await pool.query(
    `SELECT id, driver_name, zone_name, resolution, h3_cells, created_at, updated_at
     FROM driver_zones WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  return rowToResponse(parseRow(result.rows[0]));
}

export async function createDriverZone(input: DriverZoneCreateInput): Promise<DriverZoneResponse> {
  const valid = validateCells(input.h3_cells, input.resolution);

  const result = await pool.query(
    `INSERT INTO driver_zones (driver_name, zone_name, resolution, h3_cells)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, driver_name, zone_name, resolution, h3_cells, created_at, updated_at`,
    [input.driver_name, input.zone_name, input.resolution, JSON.stringify(valid)]
  );
  return rowToResponse(parseRow(result.rows[0]));
}

export async function updateDriverZone(
  id: number,
  input: DriverZoneUpdateInput
): Promise<DriverZoneResponse | null> {
  const existing = await getDriverZoneById(id);
  if (!existing) return null;

  const driver_name = input.driver_name ?? existing.driver_name;
  const zone_name = input.zone_name ?? existing.zone_name;
  const resolution = input.resolution ?? existing.resolution;
  const h3_cells = input.h3_cells ?? existing.h3_cells;

  const valid = validateCells(h3_cells, resolution);

  const result = await pool.query(
    `UPDATE driver_zones
     SET driver_name = $1,
         zone_name = $2,
         resolution = $3,
         h3_cells = $4::jsonb,
         updated_at = NOW()
     WHERE id = $5
     RETURNING id, driver_name, zone_name, resolution, h3_cells, created_at, updated_at`,
    [driver_name, zone_name, resolution, JSON.stringify(valid), id]
  );
  return rowToResponse(parseRow(result.rows[0]));
}

export async function deleteDriverZone(id: number): Promise<boolean> {
  const result = await pool.query(`DELETE FROM driver_zones WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
