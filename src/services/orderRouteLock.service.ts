import { pool } from "../database";
import { isTrackingStatus, type TrackingStatus } from "../models/orderTracking.model";

export type OrderRouteLockReason = "confirmed_route" | "delivery_in_progress";

export interface OrderRouteLockInfo {
  locked: boolean;
  selectedRouteId: number | null;
  reason: OrderRouteLockReason | null;
}

const IN_PROGRESS_TRACKING: TrackingStatus[] = [
  "PICKUP_AVAILABLE",
  "PICKED_UP",
  "IN_TRANSIT",
  "DELIVERED",
];

/**
 * Orders with a confirmed route or active delivery keep their persisted routes
 * and statuses even when zones/schedules change and no live path exists anymore.
 */
export async function getOrderRouteLockInfo(orderId: number): Promise<OrderRouteLockInfo> {
  const result = await pool.query(
    `SELECT rs.status AS selection_status,
            rs.selected_route_id,
            o.tracking_status,
            o.pickup_ready_at
     FROM orders o
     LEFT JOIN route_selections rs ON rs.order_id = o.id
     WHERE o.id = $1`,
    [orderId]
  );
  if (result.rowCount === 0) {
    return { locked: false, selectedRouteId: null, reason: null };
  }

  const row = result.rows[0];
  const selectedRouteId =
    row.selected_route_id != null ? Number(row.selected_route_id) : null;
  const selectionStatus =
    row.selection_status != null ? String(row.selection_status) : null;
  const tracking: TrackingStatus = isTrackingStatus(row.tracking_status)
    ? row.tracking_status
    : "CONFIRMED";
  const pickupReady = row.pickup_ready_at != null;

  if (selectionStatus === "confirmed") {
    return { locked: true, selectedRouteId, reason: "confirmed_route" };
  }

  if (IN_PROGRESS_TRACKING.includes(tracking) && (pickupReady || tracking !== "PICKUP_AVAILABLE")) {
    return { locked: true, selectedRouteId, reason: "delivery_in_progress" };
  }

  return { locked: false, selectedRouteId, reason: null };
}

export async function isOrderRouteLocked(orderId: number): Promise<boolean> {
  return (await getOrderRouteLockInfo(orderId)).locked;
}
