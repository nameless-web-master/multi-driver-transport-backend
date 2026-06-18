export type SegmentCostStatus = "calculated" | "manual" | "missing" | "requested";
export type SegmentCostSource = "calculated" | "manual" | "external";
export type RouteCostStatus = "complete" | "partial" | "missing";

export interface OrderRouteRow {
  id: number;
  order_id: number;
  route_label: string;
  route_index: number;
  zone_ids: number[];
  connection_ids: number[];
  transporter_ids: number[];
  is_complete: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SegmentCostBreakdown {
  base_cost: number;
  package_factor: number;
  adjusted_base_cost: number;
  travelling_cost: number;
  waiting_cost: number;
  sub_total: number;
  booking_fee_rate: number;
  booking_fee: number;
  total_cost: number;
}

export interface RouteSegmentCostRow {
  id: number;
  route_id: number;
  segment_index: number;
  transporter_id: number;
  from_node_id: string;
  to_node_id: string;
  transport_method: string;
  package_weight: number | null;
  package_volume: number | null;
  distance_h3_cells: number | null;
  distance_km: number | null;
  time_hours: number | null;
  package_factor: number | null;
  base_fee: number | null;
  weight_cost: number | null;
  volume_cost: number | null;
  distance_cost: number | null;
  waiting_cost: number | null;
  booking_fee: number | null;
  time_factor_amount: number | null;
  calculated_cost: number | null;
  manual_cost: number | null;
  final_cost: number | null;
  cost_status: SegmentCostStatus;
  cost_source: SegmentCostSource | null;
  currency: string;
  calculation_breakdown: SegmentCostBreakdown | null;
  created_at: Date;
  updated_at: Date;
}

export interface RouteCostSummaryRow {
  id: number;
  route_id: number;
  order_id: number;
  total_calculated_cost: number | null;
  total_manual_cost: number | null;
  total_final_cost: number | null;
  missing_segment_count: number;
  requested_segment_count: number;
  currency: string;
  status: RouteCostStatus;
  created_at: Date;
  updated_at: Date;
}

export interface RouteSegmentCostResponse {
  segment_id: number;
  segment_index: number;
  transporter_id: number;
  transporter_name: string;
  from_node_id: string;
  from_label: string;
  to_node_id: string;
  to_label: string;
  transport_method: string;
  distance_h3_cells: number | null;
  distance_km: number | null;
  time_hours: number | null;
  package_factor: number | null;
  base_fee: number | null;
  distance_cost: number | null;
  waiting_cost: number | null;
  booking_fee: number | null;
  weight_cost: number | null;
  volume_cost: number | null;
  time_factor_amount: number | null;
  calculated_cost: number | null;
  manual_cost: number | null;
  final_cost: number | null;
  cost_status: SegmentCostStatus;
  cost_source: SegmentCostSource | null;
  currency: string;
  breakdown: SegmentCostBreakdown | null;
}

export interface RouteCostSummaryResponse {
  route_id: number;
  order_id: number;
  route_label: string;
  transporters: string[];
  segment_count: number;
  total_calculated_cost: number | null;
  total_manual_cost: number | null;
  total_final_cost: number | null;
  missing_segment_count: number;
  requested_segment_count: number;
  currency: string;
  status: RouteCostStatus;
  segments: RouteSegmentCostResponse[];
}

export interface OrderRouteCostComparisonResponse {
  order_id: number;
  currency: string;
  booking_fee_rate: number;
  package_type: string | null;
  package_factor: number | null;
  package_weight_lbs: number | null;
  package_dimensions_in: string | null;
  routes: RouteCostSummaryResponse[];
}

/** Pending segment cost work for a transporter (quote requested or missing rates). */
export interface TransporterQuoteRequestItem {
  order_id: number;
  order_status: string;
  sender_address: string;
  destination_address: string;
  package_type: string | null;
  package_weight_lbs: number | null;
  package_dimensions_in: string | null;
  route_id: number;
  route_label: string;
  segment: RouteSegmentCostResponse;
  updated_at: string;
}

/** Segment still needs a price entered (missing rates or air quote pending). */
export function segmentNeedsCostEntry(status: SegmentCostStatus): boolean {
  return status === "missing" || status === "requested";
}

/** Only `missing` should trigger automatic recalculation (not stable `requested`). */
export function segmentNeedsRecalculation(status: SegmentCostStatus): boolean {
  return status === "missing";
}
