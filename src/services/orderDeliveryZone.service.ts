import { pool } from "../database";
import { isTrackingStatus, type TrackingStatus } from "../models/orderTracking.model";
import { addStatusHistory } from "./order_status.service";

function parseZoneIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((v) => Number(v)).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

/** True when every zone on the selected route is still marked available. */
export async function areSelectedRouteZonesAvailable(orderId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT r.zone_ids
     FROM route_selections rs
     JOIN order_routes r ON r.id = rs.selected_route_id
     WHERE rs.order_id = $1 AND rs.status = 'confirmed'`,
    [orderId]
  );
  if (result.rowCount === 0) return true;

  const zoneIds = parseZoneIds(result.rows[0].zone_ids);
  if (zoneIds.length === 0) return true;

  const zoneCheck = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE available = TRUE)::int AS available_count
     FROM driver_zones
     WHERE id = ANY($1::int[])`,
    [zoneIds]
  );
  const total = Number(zoneCheck.rows[0]?.total ?? 0);
  const availableCount = Number(zoneCheck.rows[0]?.available_count ?? 0);
  return total > 0 && total === availableCount;
}

/**
 * Only for DELIVERED orders: if route zones became unavailable, clear delivery
 * completion so the sender must select a route again. In-progress deliveries
 * are never rolled back when zones go offline.
 */
export async function revalidateDeliveredOrderZones(orderId: number): Promise<boolean> {
  const orderResult = await pool.query(
    `SELECT tracking_status FROM orders WHERE id = $1`,
    [orderId]
  );
  if (orderResult.rowCount === 0) return false;

  const raw = orderResult.rows[0].tracking_status;
  const tracking: TrackingStatus = isTrackingStatus(raw) ? raw : "CONFIRMED";
  if (tracking !== "DELIVERED") return false;

  const zonesOk = await areSelectedRouteZonesAvailable(orderId);
  if (zonesOk) return false;

  await pool.query(
    `UPDATE orders
     SET tracking_status = 'CONFIRMED', pickup_ready_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [orderId]
  );

  await pool.query(
    `UPDATE segment_confirmations sc
     SET leg_status = 'not_started'
     FROM order_routes r
     JOIN route_selections rs ON rs.selected_route_id = r.id AND rs.order_id = $1
     WHERE sc.route_id = r.id`,
    [orderId]
  );

  await pool.query(`DELETE FROM route_selections WHERE order_id = $1`, [orderId]);
  await addStatusHistory(orderId, "ROUTE_INVALIDATED_ZONES_UNAVAILABLE", null);

  return true;
}
