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
    `SELECT address, lat, lng FROM users WHERE id = $1`,
    [ctx.userId]
  );
  const senderRow = sender.rows[0] ?? {};

  const senderAddress = data.sender_address?.trim() || String(senderRow.address ?? "");
  const senderLat = data.sender_lat ?? toNullable(senderRow.lat);
  const senderLng = data.sender_lng ?? toNullable(senderRow.lng);

  const insert = await pool.query(
    `INSERT INTO orders
       (sender_user_id, receiver_user_id, driver_user_id,
        sender_address, sender_lat, sender_lng,
        destination_address, destination_lat, destination_lng,
        receiver_phone, notes, status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'submitted', NOW())
     RETURNING id`,
    [
      ctx.userId,
      data.receiver_user_id,
      data.driver_user_id ?? null,
      senderAddress,
      senderLat,
      senderLng,
      String(r.address ?? ""),
      toNullable(r.lat),
      toNullable(r.lng),
      String(r.phone ?? ""),
      data.notes ?? "",
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
