import { pool } from "../database";
import { normalizeCurrency } from "../models/currency.model";
import type {
  PricingRegionResponse,
  PricingRegionRow,
  RegionRateDefaults,
} from "../models/pricingRegion.model";
import type {
  CreatePricingRegionRequest,
  UpdatePricingRegionRequest,
} from "../schemas/pricingRegion.schema";

export class PricingRegionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "PricingRegionError";
  }
}

function toNullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToResponse(row: PricingRegionRow): PricingRegionResponse {
  return {
    id: row.id,
    name: row.name,
    base_fee: row.base_fee,
    cost_per_km: row.cost_per_km,
    cost_per_hour: row.cost_per_hour,
    currency: row.currency,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function parseRow(row: Record<string, unknown>): PricingRegionRow {
  return {
    id: Number(row.id),
    name: String(row.name),
    base_fee: toNullableNum(row.base_fee),
    cost_per_km: toNullableNum(row.cost_per_km),
    cost_per_hour: toNullableNum(row.cost_per_hour),
    currency: normalizeCurrency(row.currency == null ? undefined : String(row.currency)),
    created_at: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}

export function mergeZoneRateWithRegion(
  zone: {
    base_fee: number | null;
    cost_per_km: number | null;
    cost_per_hour: number | null;
    currency: string;
  },
  region: RegionRateDefaults | null | undefined
): RegionRateDefaults {
  return {
    base_fee: zone.base_fee ?? region?.base_fee ?? null,
    cost_per_km: zone.cost_per_km ?? region?.cost_per_km ?? null,
    cost_per_hour: zone.cost_per_hour ?? region?.cost_per_hour ?? null,
    currency: zone.currency || region?.currency || "CAD",
  };
}

export function rateDefaultsConfigured(rate: RegionRateDefaults): boolean {
  return rate.base_fee != null || rate.cost_per_km != null || rate.cost_per_hour != null;
}

export async function listPricingRegions(): Promise<PricingRegionResponse[]> {
  const result = await pool.query(
    `SELECT id, name, base_fee, cost_per_km, cost_per_hour, currency, created_at, updated_at
     FROM pricing_regions
     ORDER BY name ASC`
  );
  return result.rows.map((row) => rowToResponse(parseRow(row)));
}

export async function getPricingRegionById(id: number): Promise<PricingRegionResponse | null> {
  const result = await pool.query(
    `SELECT id, name, base_fee, cost_per_km, cost_per_hour, currency, created_at, updated_at
     FROM pricing_regions WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return rowToResponse(parseRow(result.rows[0]));
}

export async function createPricingRegion(
  data: CreatePricingRegionRequest
): Promise<PricingRegionResponse> {
  const result = await pool.query(
    `INSERT INTO pricing_regions (name, base_fee, cost_per_km, cost_per_hour, currency)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      data.name.trim(),
      data.base_fee ?? null,
      data.cost_per_km ?? null,
      data.cost_per_hour ?? null,
      normalizeCurrency(data.currency),
    ]
  );
  return rowToResponse(parseRow(result.rows[0]));
}

export async function updatePricingRegion(
  id: number,
  data: UpdatePricingRegionRequest
): Promise<PricingRegionResponse> {
  const existing = await getPricingRegionById(id);
  if (!existing) throw new PricingRegionError("Pricing region not found", 404);

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(data.name.trim());
  }
  if (data.base_fee !== undefined) {
    fields.push(`base_fee = $${idx++}`);
    values.push(data.base_fee);
  }
  if (data.cost_per_km !== undefined) {
    fields.push(`cost_per_km = $${idx++}`);
    values.push(data.cost_per_km);
  }
  if (data.cost_per_hour !== undefined) {
    fields.push(`cost_per_hour = $${idx++}`);
    values.push(data.cost_per_hour);
  }
  if (data.currency !== undefined) {
    fields.push(`currency = $${idx++}`);
    values.push(normalizeCurrency(data.currency));
  }

  fields.push("updated_at = NOW()");
  values.push(id);

  const result = await pool.query(
    `UPDATE pricing_regions SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rowToResponse(parseRow(result.rows[0]));
}

export async function deletePricingRegion(id: number): Promise<void> {
  const result = await pool.query(`DELETE FROM pricing_regions WHERE id = $1`, [id]);
  if (result.rowCount === 0) throw new PricingRegionError("Pricing region not found", 404);
}

export async function loadRegionsByIds(
  ids: number[]
): Promise<Map<number, RegionRateDefaults>> {
  if (ids.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, base_fee, cost_per_km, cost_per_hour, currency
     FROM pricing_regions WHERE id = ANY($1::int[])`,
    [ids]
  );
  const map = new Map<number, RegionRateDefaults>();
  for (const row of result.rows) {
    map.set(Number(row.id), {
      base_fee: toNullableNum(row.base_fee),
      cost_per_km: toNullableNum(row.cost_per_km),
      cost_per_hour: toNullableNum(row.cost_per_hour),
      currency: String(row.currency ?? "CAD"),
    });
  }
  return map;
}
