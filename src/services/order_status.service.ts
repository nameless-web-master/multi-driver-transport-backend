import { pool } from "../database";
import {
  isTrackingStatus,
  type OrderStatusHistoryEntry,
  type OrderTrackingResponse,
  type TrackingStatus,
  TRACKING_STATUSES,
} from "../models/orderTracking.model";
import { getOrderById, syncLegacyOrderStatus, type OrderContext } from "./order.service";
import { isPffPaymentMethod } from "../utils/paymentFlow";
import { notifyOrderParticipants } from "./notification.service";
import { syncOrderTrackingFromSegments } from "./segment_tracking.service";

export class OrderStatusError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const TRANSITIONS: Record<TrackingStatus, TrackingStatus[]> = {
  AWAITING_CONNECT: [],
  REJECTED: [],
  CONFIRMED: ["PICKUP_AVAILABLE"],
  PICKUP_AVAILABLE: ["PICKED_UP"],
  PICKED_UP: ["IN_TRANSIT"],
  IN_TRANSIT: ["DELIVERED"],
  DELIVERED: [],
};

export function validateStatusTransition(
  oldStatus: TrackingStatus,
  newStatus: TrackingStatus
): boolean {
  if (oldStatus === newStatus) return true;
  return TRANSITIONS[oldStatus]?.includes(newStatus) ?? false;
}

export async function addStatusHistory(
  orderId: number,
  status: string,
  updatedBy: number | null
): Promise<void> {
  await pool.query(
    `INSERT INTO order_status_history (order_id, status, updated_by) VALUES ($1, $2, $3)`,
    [orderId, status, updatedBy]
  );
}

async function assertRouteConfirmed(orderId: number): Promise<void> {
  const result = await pool.query(
    `SELECT status FROM route_selections WHERE order_id = $1`,
    [orderId]
  );
  if (result.rowCount === 0 || String(result.rows[0].status) !== "confirmed") {
    throw new OrderStatusError("Route must be confirmed before updating tracking status", 400);
  }
}

async function loadPickupReadyAt(orderId: number): Promise<Date | null> {
  const result = await pool.query(
    `SELECT pickup_ready_at FROM orders WHERE id = $1`,
    [orderId]
  );
  const raw = result.rows[0]?.pickup_ready_at;
  return raw ? new Date(String(raw)) : null;
}

async function getDriverSegmentContext(
  orderId: number,
  userId: number
): Promise<{ segment_index: number; segment_count: number } | null> {
  const result = await pool.query(
    `SELECT rsc.segment_index,
            (
              SELECT COUNT(*)::int
              FROM route_segment_costs rsc2
              JOIN route_selections rs2
                ON rs2.selected_route_id = rsc2.route_id AND rs2.order_id = $1
            ) AS segment_count
     FROM route_segment_costs rsc
     JOIN route_selections rs
       ON rs.selected_route_id = rsc.route_id AND rs.order_id = $1
     WHERE rsc.transporter_id = $2
     ORDER BY rsc.segment_index
     LIMIT 1`,
    [orderId, userId]
  );
  if (result.rowCount === 0) return null;
  return {
    segment_index: Number(result.rows[0].segment_index),
    segment_count: Number(result.rows[0].segment_count ?? 0),
  };
}

function inTransitSegmentIndex(segmentCount: number): number {
  return segmentCount <= 1 ? 0 : 1;
}

export async function getOrderStatus(
  orderId: number,
  ctx: OrderContext
): Promise<OrderTrackingResponse> {
  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderStatusError("Order not found", 404);

  await syncOrderTrackingFromSegments(orderId);

  const histResult = await pool.query(
    `SELECT h.*, u.full_name AS updated_by_name
     FROM order_status_history h
     LEFT JOIN users u ON u.id = h.updated_by
     WHERE h.order_id = $1
     ORDER BY h.timestamp ASC`,
    [orderId]
  );

  const history: OrderStatusHistoryEntry[] = histResult.rows.map((row) => ({
    id: Number(row.id),
    status: String(row.status),
    updated_by: row.updated_by != null ? Number(row.updated_by) : null,
    updated_by_name: row.updated_by_name != null ? String(row.updated_by_name) : null,
    timestamp: new Date(row.timestamp).toISOString(),
  }));

  const trackingResult = await pool.query(
    `SELECT tracking_status, pickup_ready_at FROM orders WHERE id = $1`,
    [orderId]
  );
  const raw = trackingResult.rows[0]?.tracking_status;
  const tracking_status: TrackingStatus = isTrackingStatus(raw) ? raw : "CONFIRMED";
  const pickupReadyRaw = trackingResult.rows[0]?.pickup_ready_at;

  return {
    order_id: orderId,
    tracking_status,
    pickup_ready_at: pickupReadyRaw ? new Date(String(pickupReadyRaw)).toISOString() : null,
    legacy_status: order.status,
    history,
  };
}

export async function updateOrderStatus(
  orderId: number,
  status: TrackingStatus,
  ctx: OrderContext
): Promise<OrderTrackingResponse> {
  if (!isTrackingStatus(status)) {
    throw new OrderStatusError(`Invalid tracking status. Allowed: ${TRACKING_STATUSES.join(", ")}`);
  }

  const order = await getOrderById(orderId, ctx);
  if (!order) throw new OrderStatusError("Order not found", 404);

  await assertRouteConfirmed(orderId);

  if (status !== "DELIVERED") {
    const awaiting = await pool.query(
      `SELECT tracking_status FROM orders WHERE id = $1`,
      [orderId]
    );
    const ts = awaiting.rows[0]?.tracking_status;
    if (ts === "AWAITING_CONNECT") {
      throw new OrderStatusError("Sender must connect this order before updating delivery status", 400);
    }
  }

  const currentResult = await pool.query(
    `SELECT tracking_status, pickup_ready_at FROM orders WHERE id = $1`,
    [orderId]
  );
  const currentRaw = currentResult.rows[0]?.tracking_status;
  const current: TrackingStatus = isTrackingStatus(currentRaw) ? currentRaw : "CONFIRMED";
  const pickupReadyAt = currentResult.rows[0]?.pickup_ready_at
    ? new Date(String(currentResult.rows[0].pickup_ready_at))
    : null;

  if (status === "PICKUP_AVAILABLE") {
    const isPff = isPffPaymentMethod(order.payment_method);
    if (isPff) {
      if (ctx.role !== "receiver" && ctx.role !== "admin") {
        throw new OrderStatusError(
          "Only the receiver can mark pickup available for PFF (Advanced Payment) orders",
          403
        );
      }
      if (ctx.role === "receiver" && order.receiver_user_id !== ctx.userId) {
        throw new OrderStatusError("Forbidden", 403);
      }
    } else if (ctx.role !== "sender" && ctx.role !== "admin") {
      throw new OrderStatusError("Only the sender can mark pickup as ready", 403);
    }
    if (pickupReadyAt) {
      return getOrderStatus(orderId, ctx);
    }
    if (current !== "CONFIRMED" && current !== "PICKUP_AVAILABLE") {
      throw new OrderStatusError("Cannot mark pickup ready from the current status", 400);
    }
    await pool.query(
      `UPDATE orders
       SET tracking_status = 'PICKUP_AVAILABLE', pickup_ready_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [orderId]
    );
    await addStatusHistory(orderId, "PICKUP_AVAILABLE", ctx.userId);
    await syncLegacyOrderStatus(orderId, "PICKUP_AVAILABLE");

    void notifyOrderParticipants({
      order_id: orderId,
      type: "pickup_ready",
      title: isPff ? "PFF pickup available" : "Pickup ready",
      body: isPff
        ? `Shipment #${orderId}: receiver marked pickup available. Producer — prepare payment package (cheque/cash) for the delivering transporter. Transporters may begin collection.`
        : `Shipment #${orderId} is ready for pickup. Transporters on the route can begin collection.`,
      exclude_user_id: ctx.userId,
    }).catch((err) => console.error("[notifications] pickup_ready failed:", err));

    return getOrderStatus(orderId, ctx);
  }

  if (!pickupReadyAt) {
    throw new OrderStatusError("Sender must mark pickup as ready first", 400);
  }

  if (!validateStatusTransition(current, status)) {
    throw new OrderStatusError(
      `Cannot transition from ${current} to ${status}. Valid next: ${TRANSITIONS[current].join(", ") || "none"}`
    );
  }

  if (status === "PICKED_UP" || status === "IN_TRANSIT") {
    if (ctx.role === "driver") {
      throw new OrderStatusError(
        "Use segment-level status updates on the confirmations page for each leg",
        400
      );
    }
    if (ctx.role !== "admin") {
      throw new OrderStatusError("Forbidden", 403);
    }
  } else if (status === "DELIVERED") {
    if (ctx.role !== "receiver" && ctx.role !== "admin") {
      throw new OrderStatusError("Only the receiver can mark the order as delivered", 403);
    }
    if (ctx.role === "receiver" && order.receiver_user_id !== ctx.userId) {
      throw new OrderStatusError("Forbidden", 403);
    }
  }

  await pool.query(
    `UPDATE orders SET tracking_status = $2, updated_at = NOW() WHERE id = $1`,
    [orderId, status]
  );
  await addStatusHistory(orderId, status, ctx.userId);
  await syncLegacyOrderStatus(orderId, status);

  if (status === "DELIVERED") {
    void notifyOrderParticipants({
      order_id: orderId,
      type: "delivered",
      title: "Shipment delivered",
      body: `Shipment #${orderId} was marked as delivered.`,
      exclude_user_id: ctx.userId,
    }).catch((err) => console.error("[notifications] delivered failed:", err));
  }

  return getOrderStatus(orderId, ctx);
}
