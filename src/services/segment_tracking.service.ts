import { pool } from "../database";
import {
  isSegmentLegStatus,
  type SegmentLegStatus,
  SEGMENT_LEG_STATUSES,
} from "../models/routeConfirmation.model";
import type { TrackingStatus } from "../models/orderTracking.model";
import { isTrackingStatus } from "../models/orderTracking.model";
import { addStatusHistory } from "./order_status.service";
import { notifyOrderParticipants } from "./notification.service";
import { syncLegacyOrderStatus, type OrderContext } from "./order.service";

export class SegmentTrackingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface SegmentRow {
  confirmation_id: number;
  route_id: number;
  segment_id: number;
  segment_index: number;
  transporter_id: number;
  confirmation_status: string;
  leg_status: SegmentLegStatus;
  order_id: number;
}

async function loadSegment(segmentId: number): Promise<SegmentRow | null> {
  const result = await pool.query(
    `SELECT sc.id AS confirmation_id,
            sc.route_id,
            sc.segment_id,
            sc.transporter_id,
            sc.status AS confirmation_status,
            sc.leg_status,
            rsc.segment_index,
            r.order_id
     FROM segment_confirmations sc
     JOIN route_segment_costs rsc ON rsc.id = sc.segment_id
     JOIN order_routes r ON r.id = sc.route_id
     WHERE sc.segment_id = $1`,
    [segmentId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  const legRaw = row.leg_status;
  return {
    confirmation_id: Number(row.confirmation_id),
    route_id: Number(row.route_id),
    segment_id: Number(row.segment_id),
    segment_index: Number(row.segment_index),
    transporter_id: Number(row.transporter_id),
    confirmation_status: String(row.confirmation_status),
    leg_status: isSegmentLegStatus(legRaw) ? legRaw : "not_started",
    order_id: Number(row.order_id),
  };
}

async function assertRouteConfirmedForOrder(orderId: number): Promise<void> {
  const result = await pool.query(
    `SELECT status FROM route_selections WHERE order_id = $1`,
    [orderId]
  );
  if (result.rowCount === 0 || String(result.rows[0].status) !== "confirmed") {
    throw new SegmentTrackingError("Route must be confirmed before updating segment status", 400);
  }
}

async function assertPickupReady(orderId: number): Promise<void> {
  const result = await pool.query(
    `SELECT pickup_ready_at FROM orders WHERE id = $1`,
    [orderId]
  );
  if (!result.rows[0]?.pickup_ready_at) {
    throw new SegmentTrackingError("Sender must mark pickup as ready first", 400);
  }
}

async function getPreviousLegStatus(
  routeId: number,
  segmentIndex: number
): Promise<SegmentLegStatus | null> {
  if (segmentIndex <= 0) return null;
  const result = await pool.query(
    `SELECT sc.leg_status
     FROM route_segment_costs rsc
     JOIN segment_confirmations sc ON sc.segment_id = rsc.id
     WHERE rsc.route_id = $1 AND rsc.segment_index = $2`,
    [routeId, segmentIndex - 1]
  );
  if (result.rowCount === 0) return null;
  const raw = result.rows[0].leg_status;
  return isSegmentLegStatus(raw) ? raw : "not_started";
}

export function deriveTrackingStatusFromLegs(
  legs: SegmentLegStatus[],
  pickupReady: boolean
): TrackingStatus {
  if (!pickupReady) return "CONFIRMED";

  let newStatus: TrackingStatus = "PICKUP_AVAILABLE";
  const allInTransit = legs.length > 0 && legs.every((l) => l === "in_transit");
  const anyInTransit = legs.some((l) => l === "in_transit");
  const firstPickedUp = legs[0] === "picked_up" || legs[0] === "in_transit";

  if (allInTransit || anyInTransit) {
    newStatus = "IN_TRANSIT";
  } else if (firstPickedUp) {
    newStatus = legs.length === 1 ? "IN_TRANSIT" : "PICKED_UP";
  }

  return newStatus;
}

export async function syncOrderTrackingFromSegments(orderId: number): Promise<TrackingStatus | null> {
  const pickupResult = await pool.query(
    `SELECT pickup_ready_at, tracking_status FROM orders WHERE id = $1`,
    [orderId]
  );
  if (!pickupResult.rows[0]?.pickup_ready_at) return null;

  const currentRaw = pickupResult.rows[0].tracking_status;
  const current: TrackingStatus = isTrackingStatus(currentRaw) ? currentRaw : "CONFIRMED";
  if (current === "DELIVERED") return "DELIVERED";

  const result = await pool.query(
    `SELECT sc.leg_status, rsc.segment_index
     FROM segment_confirmations sc
     JOIN route_segment_costs rsc ON rsc.id = sc.segment_id
     JOIN route_selections rs ON rs.selected_route_id = sc.route_id AND rs.order_id = $1
     WHERE sc.status = 'accepted'
     ORDER BY rsc.segment_index`,
    [orderId]
  );
  if (result.rowCount === 0) return null;

  const legs = result.rows.map((r) =>
    isSegmentLegStatus(r.leg_status) ? r.leg_status : ("not_started" as SegmentLegStatus)
  );

  const newStatus = deriveTrackingStatusFromLegs(legs, true);

  if (newStatus !== current) {
    await pool.query(
      `UPDATE orders SET tracking_status = $2, updated_at = NOW() WHERE id = $1`,
      [orderId, newStatus]
    );
    await syncLegacyOrderStatus(orderId, newStatus);
  }

  return newStatus;
}

export async function updateSegmentLegStatus(
  segmentId: number,
  legStatus: SegmentLegStatus,
  ctx: OrderContext
): Promise<{ segment_id: number; leg_status: SegmentLegStatus; order_id: number }> {
  if (!isSegmentLegStatus(legStatus) || legStatus === "not_started") {
    throw new SegmentTrackingError("Invalid leg status. Allowed: picked_up, in_transit");
  }

  const seg = await loadSegment(segmentId);
  if (!seg) throw new SegmentTrackingError("Segment not found", 404);

  if (ctx.role !== "driver" && ctx.role !== "admin") {
    throw new SegmentTrackingError("Forbidden", 403);
  }
  if (ctx.role === "driver" && seg.transporter_id !== ctx.userId) {
    throw new SegmentTrackingError("You are not assigned to this segment", 403);
  }
  if (seg.confirmation_status !== "accepted") {
    throw new SegmentTrackingError("Segment must be accepted before updating delivery status", 400);
  }
  if (seg.leg_status !== "not_started") {
    throw new SegmentTrackingError("This segment leg is already in progress or complete", 400);
  }

  await assertRouteConfirmedForOrder(seg.order_id);
  await assertPickupReady(seg.order_id);

  const prevLeg = await getPreviousLegStatus(seg.route_id, seg.segment_index);

  if (legStatus === "picked_up") {
    if (seg.segment_index !== 0) {
      throw new SegmentTrackingError("Only the first segment can be marked as picked up", 403);
    }
  } else if (legStatus === "in_transit") {
    if (seg.segment_index === 0) {
      throw new SegmentTrackingError("The first segment uses picked up only", 403);
    }
    if (seg.segment_index === 1) {
      if (prevLeg !== "picked_up") {
        throw new SegmentTrackingError(
          "The first segment must be picked up before this segment can go in transit",
          400
        );
      }
    } else if (prevLeg !== "in_transit") {
      throw new SegmentTrackingError(
        "The previous segment must be in transit before this segment can start",
        400
      );
    }
  }

  await pool.query(
    `UPDATE segment_confirmations SET leg_status = $2 WHERE segment_id = $1`,
    [segmentId, legStatus]
  );

  const historyLabel = `SEG${seg.segment_index + 1}:${legStatus}`;
  await addStatusHistory(seg.order_id, historyLabel, ctx.userId);
  await syncOrderTrackingFromSegments(seg.order_id);

  const legLabel = legStatus === "picked_up" ? "picked up" : "in transit";
  void notifyOrderParticipants({
    order_id: seg.order_id,
    type: legStatus === "picked_up" ? "segment_picked_up" : "segment_in_transit",
    title: `Segment ${legLabel}`,
    body: `Segment ${seg.segment_index + 1} on shipment #${seg.order_id} was marked ${legLabel}.`,
    exclude_user_id: ctx.userId,
  }).catch((err) => console.error("[notifications] segment status failed:", err));

  return {
    segment_id: segmentId,
    leg_status: legStatus,
    order_id: seg.order_id,
  };
}

export { SEGMENT_LEG_STATUSES };
