import { latLngToCell } from "h3-js";
import { pool } from "../database";
import {
  OrderResponse,
  OrderRow,
  isOrderStatus,
  type OrderStatus,
} from "../models/order.model";
import type { UserRole } from "../models/userRole.model";
import {
  CreateOrderRequest,
  UpdateOrderStatusRequest,
} from "../schemas/order.schema";

/**
 * Default H3 resolution at which order pickup / delivery coordinates are
 * indexed. Kept in sync with the order-graph + draft-preview services so a
 * stored `pickup_h3` lines up with the cells the graph reasons about.
 */
export const ORDER_H3_RESOLUTION = 8;

/** Safely convert a coordinate pair to an H3 index; null on any failure. */
function coordsToH3(
  lat: number | null,
  lng: number | null,
  resolution: number
): string | null {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  try {
    return latLngToCell(lat, lng, resolution);
  } catch {
    return null;
  }
}

export class OrderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ORDER_SELECT = `
  SELECT o.*,
         s.full_name AS sender_name,
         s.phone     AS sender_phone_user,
         r.full_name AS receiver_name
  FROM orders o
  JOIN users s ON s.id = o.sender_user_id
  JOIN users r ON r.id = o.receiver_user_id
`;

function toNullable(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToOrder(row: Record<string, unknown>): OrderResponse {
  const status = isOrderStatus(row.status) ? (row.status as OrderStatus) : "submitted";
  const order: OrderRow = {
    id: Number(row.id),
    sender_user_id: Number(row.sender_user_id),
    receiver_user_id: Number(row.receiver_user_id),
    driver_user_id: row.driver_user_id !== null && row.driver_user_id !== undefined
      ? Number(row.driver_user_id)
      : null,
    sender_address: String(row.sender_address ?? ""),
    sender_lat: toNullable(row.sender_lat),
    sender_lng: toNullable(row.sender_lng),
    destination_address: String(row.destination_address ?? ""),
    destination_lat: toNullable(row.destination_lat),
    destination_lng: toNullable(row.destination_lng),
    receiver_phone: String(row.receiver_phone ?? ""),
    notes: String(row.notes ?? ""),
    pickup_h3: row.pickup_h3 != null ? String(row.pickup_h3) : null,
    delivery_h3: row.delivery_h3 != null ? String(row.delivery_h3) : null,
    h3_resolution: toNullable(row.h3_resolution),
    source_name: String(row.source_name ?? ""),
    source_contact: String(row.source_contact ?? ""),
    payment_method: String(row.payment_method ?? ""),
    shipping_method: String(row.shipping_method ?? ""),
    package_description: String(row.package_description ?? ""),
    weight_kg: toNullable(row.weight_kg),
    package_weight_unit: String(row.package_weight_unit ?? "kg"),
    package_length: toNullable(row.package_length),
    package_width: toNullable(row.package_width),
    package_height: toNullable(row.package_height),
    package_dimension_unit: String(row.package_dimension_unit ?? "cm"),
    dimensions: String(row.dimensions ?? ""),
    status,
    submitted_at: new Date(String(row.submitted_at)),
    delivering_at: row.delivering_at ? new Date(String(row.delivering_at)) : null,
    received_at: row.received_at ? new Date(String(row.received_at)) : null,
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };

  return {
    id: order.id,
    sender_user_id: order.sender_user_id,
    receiver_user_id: order.receiver_user_id,
    driver_user_id: order.driver_user_id,
    sender_name: String(row.sender_name ?? ""),
    sender_phone: String(row.sender_phone_user ?? ""),
    receiver_name: String(row.receiver_name ?? ""),
    receiver_phone: order.receiver_phone,
    sender_address: order.sender_address,
    sender_lat: order.sender_lat,
    sender_lng: order.sender_lng,
    destination_address: order.destination_address,
    destination_lat: order.destination_lat,
    destination_lng: order.destination_lng,
    notes: order.notes,
    pickup_h3: order.pickup_h3,
    delivery_h3: order.delivery_h3,
    h3_resolution: order.h3_resolution,
    source_name: order.source_name,
    source_contact: order.source_contact,
    payment_method: order.payment_method,
    shipping_method: order.shipping_method,
    package_description: order.package_description,
    weight_kg: order.weight_kg,
    package_weight_unit: order.package_weight_unit,
    package_length: order.package_length,
    package_width: order.package_width,
    package_height: order.package_height,
    package_dimension_unit: order.package_dimension_unit,
    dimensions: order.dimensions,
    status: order.status,
    submitted_at: order.submitted_at.toISOString(),
    delivering_at: order.delivering_at?.toISOString() ?? null,
    received_at: order.received_at?.toISOString() ?? null,
    created_at: order.created_at.toISOString(),
    updated_at: order.updated_at.toISOString(),
  };
}

export interface OrderContext {
  userId: number;
  role: UserRole;
}

export async function createOrder(
  ctx: OrderContext,
  data: CreateOrderRequest
): Promise<OrderResponse> {
  if (ctx.role !== "sender" && ctx.role !== "admin") {
    throw new OrderError("Only senders can create orders", 403);
  }

  const receiver = await pool.query(
    `SELECT id, role, full_name, phone, address, lat, lng FROM users WHERE id = $1`,
    [data.receiver_user_id]
  );
  if (receiver.rowCount === 0) throw new OrderError("Receiver not found", 404);
  const r = receiver.rows[0];
  if (r.role !== "receiver") {
    throw new OrderError("Selected user is not a receiver", 400);
  }

  const sender = await pool.query(
    `SELECT full_name, address, lat, lng FROM users WHERE id = $1`,
    [ctx.userId]
  );
  const senderRow = sender.rows[0] ?? {};

  const senderAddress = data.sender_address?.trim() || String(senderRow.address ?? "");
  const senderLat = data.sender_lat ?? toNullable(senderRow.lat);
  const senderLng = data.sender_lng ?? toNullable(senderRow.lng);

  const destinationLat = toNullable(r.lat);
  const destinationLng = toNullable(r.lng);

  // Milestone 1 (updated scope): convert pickup + delivery coordinates to
  // H3 indexes and persist them with the order so later milestones (and the
  // order graph) reason about coverage without recomputing on every read.
  const pickupH3 = coordsToH3(senderLat, senderLng, ORDER_H3_RESOLUTION);
  const deliveryH3 = coordsToH3(destinationLat, destinationLng, ORDER_H3_RESOLUTION);

  const packageLength = data.package_length ?? null;
  const packageWidth = data.package_width ?? null;
  const packageHeight = data.package_height ?? null;
  const dimensionsText =
    data.dimensions?.trim() ||
    (packageLength != null && packageWidth != null && packageHeight != null
      ? `${packageLength} × ${packageWidth} × ${packageHeight} ${data.package_dimension_unit ?? "cm"}`
      : "");

  const insert = await pool.query(
    `INSERT INTO orders
       (sender_user_id, receiver_user_id, driver_user_id,
        sender_address, sender_lat, sender_lng,
        destination_address, destination_lat, destination_lng,
        receiver_phone, notes,
        pickup_h3, delivery_h3, h3_resolution,
        source_name, source_contact, payment_method, shipping_method,
        package_description, weight_kg, package_weight_unit,
        package_length, package_width, package_height, package_dimension_unit,
        dimensions,
        status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             $22, $23, $24, $25, $26,
             'submitted', NOW())
     RETURNING id`,
    [
      ctx.userId,
      data.receiver_user_id,
      data.driver_user_id ?? null,
      senderAddress,
      senderLat,
      senderLng,
      String(r.address ?? ""),
      destinationLat,
      destinationLng,
      String(r.phone ?? ""),
      data.notes ?? "",
      pickupH3,
      deliveryH3,
      ORDER_H3_RESOLUTION,
      data.source_name?.trim() || String(senderRow.full_name ?? ""),
      data.source_contact ?? "",
      data.payment_method ?? "",
      data.shipping_method ?? "",
      data.package_description ?? "",
      data.weight_kg ?? null,
      data.package_weight_unit ?? "kg",
      packageLength,
      packageWidth,
      packageHeight,
      data.package_dimension_unit ?? "cm",
      dimensionsText,
    ]
  );

  const created = await getOrderById(Number(insert.rows[0].id), ctx);
  if (!created) throw new OrderError("Failed to load freshly created order", 500);
  return created;
}

export async function listOrders(ctx: OrderContext): Promise<OrderResponse[]> {
  const params: unknown[] = [];
  let where = "";
  if (ctx.role === "sender") {
    params.push(ctx.userId);
    where = `WHERE o.sender_user_id = $1`;
  } else if (ctx.role === "receiver") {
    params.push(ctx.userId);
    where = `WHERE o.receiver_user_id = $1`;
  } else if (ctx.role === "driver") {
    params.push(ctx.userId);
    where = `WHERE o.driver_user_id = $1`;
  }

  const result = await pool.query(
    `${ORDER_SELECT} ${where} ORDER BY o.created_at DESC`,
    params
  );
  return result.rows.map(rowToOrder);
}

export async function getOrderById(id: number, ctx: OrderContext): Promise<OrderResponse | null> {
  const params: unknown[] = [id];
  let extra = "";
  if (ctx.role === "sender") {
    params.push(ctx.userId);
    extra = ` AND o.sender_user_id = $${params.length}`;
  } else if (ctx.role === "receiver") {
    params.push(ctx.userId);
    extra = ` AND o.receiver_user_id = $${params.length}`;
  } else if (ctx.role === "driver") {
    params.push(ctx.userId);
    extra = ` AND o.driver_user_id = $${params.length}`;
  }
  const result = await pool.query(
    `${ORDER_SELECT} WHERE o.id = $1${extra}`,
    params
  );
  if (result.rowCount === 0) return null;
  return rowToOrder(result.rows[0]);
}

export async function updateOrderStatus(
  id: number,
  ctx: OrderContext,
  data: UpdateOrderStatusRequest
): Promise<OrderResponse> {
  const existing = await getOrderById(id, ctx);
  if (!existing) throw new OrderError("Order not found", 404);

  if (data.status === "delivering") {
    if (ctx.role !== "sender" && ctx.role !== "admin") {
      throw new OrderError("Only the sender can mark an order as delivering", 403);
    }
    if (existing.status !== "submitted") {
      throw new OrderError("Only submitted orders can be marked as delivering", 400);
    }
    await pool.query(
      `UPDATE orders SET status = 'delivering', delivering_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
  } else if (data.status === "received") {
    if (ctx.role !== "receiver" && ctx.role !== "admin") {
      throw new OrderError("Only the receiver can mark an order as received", 403);
    }
    if (existing.status !== "delivering") {
      throw new OrderError("Only delivering orders can be marked as received", 400);
    }
    await pool.query(
      `UPDATE orders SET status = 'received', received_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  const refreshed = await getOrderById(id, ctx);
  if (!refreshed) throw new OrderError("Failed to load order", 500);
  return refreshed;
}

/**
 * One-shot backfill: populate `pickup_h3` / `delivery_h3` (and the
 * resolution) for orders created before these columns existed, deriving
 * them from the coordinates already stored on the row. Idempotent — only
 * touches rows whose H3 is still NULL but which have coordinates. Safe to
 * run on every boot; it's a no-op once everything is filled.
 */
export async function backfillOrderH3(): Promise<number> {
  const result = await pool.query(
    `SELECT id, sender_lat, sender_lng, destination_lat, destination_lng
     FROM orders
     WHERE (pickup_h3 IS NULL AND sender_lat IS NOT NULL AND sender_lng IS NOT NULL)
        OR (delivery_h3 IS NULL AND destination_lat IS NOT NULL AND destination_lng IS NOT NULL)`
  );
  let updated = 0;
  for (const row of result.rows) {
    const pickupH3 = coordsToH3(
      toNullable(row.sender_lat),
      toNullable(row.sender_lng),
      ORDER_H3_RESOLUTION
    );
    const deliveryH3 = coordsToH3(
      toNullable(row.destination_lat),
      toNullable(row.destination_lng),
      ORDER_H3_RESOLUTION
    );
    await pool.query(
      `UPDATE orders
         SET pickup_h3 = COALESCE(pickup_h3, $2),
             delivery_h3 = COALESCE(delivery_h3, $3),
             h3_resolution = COALESCE(h3_resolution, $4)
       WHERE id = $1`,
      [Number(row.id), pickupH3, deliveryH3, ORDER_H3_RESOLUTION]
    );
    updated++;
  }
  return updated;
}
