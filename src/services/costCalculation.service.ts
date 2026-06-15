import { gridDistance, latLngToCell } from "h3-js";
import type {
  SegmentCostBreakdown,
  SegmentCostStatus,
} from "../models/routeCost.model";
import type { OrderResponse } from "../models/order.model";
import { ORDER_H3_RESOLUTION } from "./order.service";

export interface DerivedSegment {
  segment_index: number;
  transporter_id: number;
  from_node_id: string;
  to_node_id: string;
  transport_method: string;
  from_zone_id: number | null;
  to_zone_id: number | null;
  /** The zone(s) priced by this segment. One zone per segment. */
  zone_ids: number[];
}

export function calculatePackageVolume(
  length: number | null,
  width: number | null,
  height: number | null
): number | null {
  if (
    length == null ||
    width == null ||
    height == null ||
    !Number.isFinite(length) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    length <= 0 ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return length * width * height;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Great-circle distance in km between two lat/lng points. Used for air/sea
 * "line" routes, which are priced per km between departure and arrival hubs.
 */
export function haversineKm(
  lat1: number | null,
  lng1: number | null,
  lat2: number | null,
  lng2: number | null
): number | null {
  if (
    lat1 == null ||
    lng1 == null ||
    lat2 == null ||
    lng2 == null ||
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null;
  }
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return roundMoney(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function isLineMode(method: string): boolean {
  return method === "air" || method === "sea";
}

/**
 * H3 grid distance between two zone centroids (approximate segment length).
 */
export function calculateSegmentDistanceH3(
  fromLat: number | null,
  fromLng: number | null,
  toLat: number | null,
  toLng: number | null,
  resolution = ORDER_H3_RESOLUTION
): { distance_h3_cells: number | null; distance_km: number | null } {
  if (
    fromLat == null ||
    fromLng == null ||
    toLat == null ||
    toLng == null ||
    !Number.isFinite(fromLat) ||
    !Number.isFinite(fromLng) ||
    !Number.isFinite(toLat) ||
    !Number.isFinite(toLng)
  ) {
    return { distance_h3_cells: null, distance_km: null };
  }
  try {
    const fromCell = latLngToCell(fromLat, fromLng, resolution);
    const toCell = latLngToCell(toLat, toLng, resolution);
    const cells = gridDistance(fromCell, toCell);
    // Rough km estimate: res-8 hex edge ~0.46 km
    const kmPerCell = resolution <= 4 ? 22 : resolution <= 6 ? 3.2 : resolution <= 8 ? 0.46 : 0.17;
    return {
      distance_h3_cells: cells,
      distance_km: roundMoney(cells * kmPerCell),
    };
  } catch {
    return { distance_h3_cells: null, distance_km: null };
  }
}

/**
 * Pricing rules for a segment, sourced from the entry zone of the segment
 * (the transporter defines these on the zone). A `null` rate means the zone
 * has no pricing configured → the segment is reported as "missing cost".
 */
export interface SegmentRate {
  currency: string;
  base_fee: number | null;
  cost_per_h3_cell: number | null;
  cost_per_km: number | null;
  cost_per_kg: number | null;
  cost_per_volume_unit: number | null;
  time_of_day_factor: number | null;
  minimum_fee: number | null;
}

export interface SegmentCostInput {
  segment: DerivedSegment;
  order: Pick<
    OrderResponse,
    | "weight_kg"
    | "package_length"
    | "package_width"
    | "package_height"
    | "sender_lat"
    | "sender_lng"
    | "destination_lat"
    | "destination_lng"
  >;
  rate: SegmentRate | null;
  zoneCoords: Map<number, { lat: number; lng: number; transport_method: string | null }>;
  /**
   * For air/sea (line) segments: the great-circle distance in km between the
   * entry zone's departure and arrival hubs. Used to price the leg per km.
   */
  lineDistanceKm?: number | null;
  /**
   * Path-accurate distance for this leg, computed by the route cost service
   * from the actual zone path:
   *  - `distance_h3_cells` = number of H3 cells the package travels through
   *    (land), i.e. entry→exit per zone summed — NOT the zone's total cells.
   *  - `distance_km` = routed great-circle distance (air/sea), or a derived km
   *    for land display.
   * When present it takes precedence over the centroid estimate.
   */
  distanceOverride?: { distance_h3_cells: number | null; distance_km: number | null };
}

export interface SegmentCostResult {
  package_weight: number | null;
  package_volume: number | null;
  distance_h3_cells: number | null;
  distance_km: number | null;
  base_fee: number | null;
  weight_cost: number | null;
  volume_cost: number | null;
  distance_cost: number | null;
  time_factor_amount: number | null;
  calculated_cost: number | null;
  manual_cost: number | null;
  final_cost: number | null;
  cost_status: SegmentCostStatus;
  currency: string;
  calculation_breakdown: SegmentCostBreakdown | null;
}

function resolveCoords(
  nodeId: string,
  order: SegmentCostInput["order"],
  zoneCoords: SegmentCostInput["zoneCoords"]
): { lat: number | null; lng: number | null } {
  if (nodeId === "sender") {
    return { lat: order.sender_lat, lng: order.sender_lng };
  }
  if (nodeId === "receiver") {
    return { lat: order.destination_lat, lng: order.destination_lng };
  }
  const zoneId = Number(nodeId);
  if (Number.isFinite(zoneId)) {
    const z = zoneCoords.get(zoneId);
    if (z) return { lat: z.lat, lng: z.lng };
  }
  return { lat: null, lng: null };
}

export function calculateSegmentCost(input: SegmentCostInput): SegmentCostResult {
  const { segment, order, rate, zoneCoords } = input;
  const currency = rate?.currency ?? "CAD";
  const packageWeight = order.weight_kg;
  const packageVolume = calculatePackageVolume(
    order.package_length,
    order.package_width,
    order.package_height
  );

  if (!rate) {
    return {
      package_weight: packageWeight,
      package_volume: packageVolume,
      distance_h3_cells: null,
      distance_km: null,
      base_fee: null,
      weight_cost: null,
      volume_cost: null,
      distance_cost: null,
      time_factor_amount: null,
      calculated_cost: null,
      manual_cost: null,
      final_cost: null,
      cost_status: "missing",
      currency,
      calculation_breakdown: null,
    };
  }

  const baseFee = Number(rate.base_fee ?? 0);

  // Distance model depends on transport type:
  //  - Land zones are made of H3 cells → measured by the number of cells the
  //    package actually travels through along the route (entry→exit per zone),
  //    priced per cell. NOT the zone's total cell count.
  //  - Air/sea zones are a line between two terminals → measured by the routed
  //    great-circle distance, priced per km.
  // `distanceOverride` carries the path-accurate distance from the route cost
  // service; we only fall back to a centroid estimate when it is absent.
  const line = isLineMode(segment.transport_method);
  let distanceCells = input.distanceOverride?.distance_h3_cells ?? null;
  let distanceKm = input.distanceOverride?.distance_km ?? null;

  if (distanceCells == null && distanceKm == null) {
    if (line) {
      distanceKm = input.lineDistanceKm ?? null;
    }
    if (distanceCells == null && distanceKm == null) {
      const from = resolveCoords(segment.from_node_id, order, zoneCoords);
      const to = resolveCoords(segment.to_node_id, order, zoneCoords);
      const dist = calculateSegmentDistanceH3(from.lat, from.lng, to.lat, to.lng);
      if (line) {
        distanceKm = dist.distance_km;
      } else {
        distanceCells = dist.distance_h3_cells;
        distanceKm = dist.distance_km;
      }
    }
  }

  let distanceCost = 0;
  if (line) {
    if (rate.cost_per_km != null && distanceKm != null) {
      distanceCost = distanceKm * rate.cost_per_km;
    }
  } else if (rate.cost_per_h3_cell != null && distanceCells != null) {
    distanceCost = distanceCells * rate.cost_per_h3_cell;
  } else if (rate.cost_per_km != null && distanceKm != null) {
    distanceCost = distanceKm * rate.cost_per_km;
  }

  const weightCost =
    rate.cost_per_kg != null && packageWeight != null
      ? packageWeight * rate.cost_per_kg
      : 0;

  const volumeCost =
    rate.cost_per_volume_unit != null && packageVolume != null
      ? packageVolume * rate.cost_per_volume_unit
      : 0;

  let subtotal = baseFee + distanceCost + weightCost + volumeCost;
  let timeFactorAmount = 0;
  if (rate.time_of_day_factor != null && rate.time_of_day_factor > 0) {
    const factored = subtotal * rate.time_of_day_factor;
    timeFactorAmount = factored - subtotal;
    subtotal = factored;
  }

  let minimumApplied = false;
  if (rate.minimum_fee != null && subtotal < rate.minimum_fee) {
    subtotal = rate.minimum_fee;
    minimumApplied = true;
  }

  const calculated = roundMoney(subtotal);
  const breakdown: SegmentCostBreakdown = {
    base_fee: roundMoney(baseFee),
    distance_cost: roundMoney(distanceCost),
    weight_cost: roundMoney(weightCost),
    volume_cost: roundMoney(volumeCost),
    time_factor_amount: roundMoney(timeFactorAmount),
    subtotal_before_minimum: roundMoney(baseFee + distanceCost + weightCost + volumeCost),
    minimum_fee_applied: minimumApplied,
  };

  return {
    package_weight: packageWeight,
    package_volume: packageVolume,
    distance_h3_cells: distanceCells,
    distance_km: distanceKm,
    base_fee: breakdown.base_fee,
    weight_cost: breakdown.weight_cost,
    volume_cost: breakdown.volume_cost,
    distance_cost: breakdown.distance_cost,
    time_factor_amount: breakdown.time_factor_amount ?? 0,
    calculated_cost: calculated,
    manual_cost: null,
    final_cost: calculated,
    cost_status: "calculated",
    currency,
    calculation_breakdown: breakdown,
  };
}

/**
 * One zone = one segment.
 *
 * Each zone carries its OWN transporter, transport mode, rate and distance.
 * A single transporter may own several zones along a route — and those zones
 * can even be different modes (e.g. land → sea → land). Collapsing them into
 * one transporter "leg" would force a single mode and a single zone's rate
 * onto the whole leg, which mis-labels and mis-prices it (a cross-continent
 * sea hop priced as a handful of land cells). Keeping one segment per zone
 * lets every leg be measured and priced with its own zone's settings, and it
 * matches the per-row breakdown UI where each row has a single method/rate.
 */
export function deriveSegmentsFromRoute(
  zoneIds: number[],
  zoneMeta: Map<number, { owner_user_id: number; transport_mode: string | null }>
): DerivedSegment[] {
  if (zoneIds.length === 0) return [];

  const segments: DerivedSegment[] = [];
  for (let i = 0; i < zoneIds.length; i++) {
    const zoneId = zoneIds[i];
    const meta = zoneMeta.get(zoneId);
    if (!meta) continue;
    const method = meta.transport_mode ?? "land";

    // `from`/`to` are display boundaries that chain the path together
    // (Sender → Zone A → Zone B → Receiver). The rate is always taken from
    // THIS zone via `from_zone_id`/`to_zone_id`.
    const isFirst = segments.length === 0;
    const fromNode = isFirst ? "sender" : String(zoneIds[i - 1]);
    const toNode = i === zoneIds.length - 1 ? "receiver" : String(zoneId);

    segments.push({
      segment_index: segments.length,
      transporter_id: meta.owner_user_id,
      from_node_id: fromNode,
      to_node_id: toNode,
      transport_method: method,
      from_zone_id: zoneId,
      to_zone_id: zoneId,
      zone_ids: [zoneId],
    });
  }

  return segments;
}
