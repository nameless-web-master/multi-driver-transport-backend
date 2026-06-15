import { pool } from "../database";
import type { RateTableResponse } from "../models/rateTable.model";
import type { UserRole } from "../models/userRole.model";
import type {
  CreateRateTableRequest,
  UpdateRateTableRequest,
} from "../schemas/rateTable.schema";
import { isTransportMode } from "../models/transportMode.model";
import { normalizeCurrency } from "../models/currency.model";

export class RateTableError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface RateTableContext {
  userId: number;
  role: UserRole;
}

function toNullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToRateTable(row: Record<string, unknown>): RateTableResponse {
  const method = row.transport_method;
  if (!isTransportMode(method)) {
    throw new RateTableError("Invalid transport method on rate table row", 500);
  }
  return {
    id: Number(row.id),
    transporter_id: Number(row.transporter_id),
    transporter_name: row.transporter_name != null ? String(row.transporter_name) : undefined,
    transport_method: method,
    currency: String(row.currency ?? "CAD"),
    base_fee: Number(row.base_fee ?? 0),
    cost_per_h3_cell: toNullableNum(row.cost_per_h3_cell),
    cost_per_km: toNullableNum(row.cost_per_km),
    cost_per_kg: toNullableNum(row.cost_per_kg),
    cost_per_volume_unit: toNullableNum(row.cost_per_volume_unit),
    time_of_day_factor: toNullableNum(row.time_of_day_factor),
    minimum_fee: toNullableNum(row.minimum_fee),
    is_active: Boolean(row.is_active),
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

function resolveTransporterId(
  ctx: RateTableContext,
  requested?: number
): number {
  if (ctx.role === "admin") {
    if (!requested) {
      throw new RateTableError("transporter_id is required for admin", 400);
    }
    return requested;
  }
  if (ctx.role !== "driver") {
    throw new RateTableError("Only transporters and admins can manage rate tables", 403);
  }
  return ctx.userId;
}

async function assertTransporterExists(transporterId: number): Promise<void> {
  const result = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role = 'driver'`,
    [transporterId]
  );
  if (result.rowCount === 0) {
    throw new RateTableError("Transporter not found", 404);
  }
}

export async function createRateTable(
  ctx: RateTableContext,
  data: CreateRateTableRequest
): Promise<RateTableResponse> {
  const transporterId = resolveTransporterId(ctx, data.transporter_id);
  await assertTransporterExists(transporterId);

  const result = await pool.query(
    `INSERT INTO transporter_rate_tables
       (transporter_id, transport_method, currency, base_fee,
        cost_per_h3_cell, cost_per_km, cost_per_kg, cost_per_volume_unit,
        time_of_day_factor, minimum_fee, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      transporterId,
      data.transport_method,
      normalizeCurrency(data.currency ?? "CAD"),
      data.base_fee ?? 0,
      data.cost_per_h3_cell ?? null,
      data.cost_per_km ?? null,
      data.cost_per_kg ?? null,
      data.cost_per_volume_unit ?? null,
      data.time_of_day_factor ?? null,
      data.minimum_fee ?? null,
      data.is_active ?? true,
    ]
  );
  return rowToRateTable(result.rows[0]);
}

export interface RateTableFilters {
  transporter_id?: number;
  transport_method?: string;
  is_active?: boolean;
}

export async function getRateTables(
  ctx: RateTableContext,
  filters: RateTableFilters = {}
): Promise<RateTableResponse[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (ctx.role === "driver") {
    params.push(ctx.userId);
    clauses.push(`r.transporter_id = $${params.length}`);
  } else if (ctx.role !== "admin") {
    throw new RateTableError("Forbidden", 403);
  }

  if (filters.transporter_id != null) {
    params.push(filters.transporter_id);
    clauses.push(`r.transporter_id = $${params.length}`);
  }
  if (filters.transport_method) {
    params.push(filters.transport_method);
    clauses.push(`r.transport_method = $${params.length}`);
  }
  if (filters.is_active != null) {
    params.push(filters.is_active);
    clauses.push(`r.is_active = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT r.*, u.full_name AS transporter_name
     FROM transporter_rate_tables r
     JOIN users u ON u.id = r.transporter_id
     ${where}
     ORDER BY r.transporter_id, r.transport_method, r.created_at DESC`,
    params
  );
  return result.rows.map(rowToRateTable);
}

export async function getRateTableById(
  ctx: RateTableContext,
  id: number
): Promise<RateTableResponse | null> {
  const result = await pool.query(
    `SELECT r.*, u.full_name AS transporter_name
     FROM transporter_rate_tables r
     JOIN users u ON u.id = r.transporter_id
     WHERE r.id = $1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (ctx.role === "driver" && Number(row.transporter_id) !== ctx.userId) {
    throw new RateTableError("Forbidden", 403);
  }
  if (ctx.role !== "admin" && ctx.role !== "driver") {
    throw new RateTableError("Forbidden", 403);
  }
  return rowToRateTable(row);
}

export async function getActiveRateTable(
  transporterId: number,
  transportMethod: string
): Promise<RateTableResponse | null> {
  const result = await pool.query(
    `SELECT r.*, u.full_name AS transporter_name
     FROM transporter_rate_tables r
     JOIN users u ON u.id = r.transporter_id
     WHERE r.transporter_id = $1
       AND r.transport_method = $2
       AND r.is_active = TRUE
     ORDER BY r.updated_at DESC
     LIMIT 1`,
    [transporterId, transportMethod]
  );
  if (result.rowCount === 0) return null;
  return rowToRateTable(result.rows[0]);
}

export async function updateRateTable(
  ctx: RateTableContext,
  rateTableId: number,
  data: UpdateRateTableRequest
): Promise<RateTableResponse> {
  const existing = await getRateTableById(ctx, rateTableId);
  if (!existing) throw new RateTableError("Rate table not found", 404);

  if (ctx.role === "driver" && existing.transporter_id !== ctx.userId) {
    throw new RateTableError("Forbidden", 403);
  }

  const fields: string[] = [];
  const params: unknown[] = [rateTableId];
  const setField = (col: string, val: unknown) => {
    params.push(val);
    fields.push(`${col} = $${params.length}`);
  };

  if (data.transport_method !== undefined) setField("transport_method", data.transport_method);
  if (data.currency !== undefined) setField("currency", normalizeCurrency(data.currency));
  if (data.base_fee !== undefined) setField("base_fee", data.base_fee);
  if (data.cost_per_h3_cell !== undefined) setField("cost_per_h3_cell", data.cost_per_h3_cell);
  if (data.cost_per_km !== undefined) setField("cost_per_km", data.cost_per_km);
  if (data.cost_per_kg !== undefined) setField("cost_per_kg", data.cost_per_kg);
  if (data.cost_per_volume_unit !== undefined) setField("cost_per_volume_unit", data.cost_per_volume_unit);
  if (data.time_of_day_factor !== undefined) setField("time_of_day_factor", data.time_of_day_factor);
  if (data.minimum_fee !== undefined) setField("minimum_fee", data.minimum_fee);
  if (data.is_active !== undefined) setField("is_active", data.is_active);
  if (ctx.role === "admin" && data.transporter_id !== undefined) {
    await assertTransporterExists(data.transporter_id);
    setField("transporter_id", data.transporter_id);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = NOW()");
  const result = await pool.query(
    `UPDATE transporter_rate_tables SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
    params
  );
  return rowToRateTable(result.rows[0]);
}

export async function deactivateRateTable(
  ctx: RateTableContext,
  rateTableId: number
): Promise<void> {
  await updateRateTable(ctx, rateTableId, { is_active: false });
}
