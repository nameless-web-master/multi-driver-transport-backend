export type SegmentCostStatus = "calculated" | "manual" | "missing";
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
  base_fee: number;
  distance_cost: number;
  weight_cost: number;
  volume_cost: number;
  time_factor_amount?: number;
  subtotal_before_minimum?: number;
  minimum_fee_applied?: boolean;
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
  base_fee: number | null;
  distance_cost: number | null;
  weight_cost: number | null;
  volume_cost: number | null;
  time_factor_amount: number | null;
  calculated_cost: number | null;
  manual_cost: number | null;
  final_cost: number | null;
  cost_status: SegmentCostStatus;
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
  currency: string;
  status: RouteCostStatus;
  segments: RouteSegmentCostResponse[];
}

export interface OrderRouteCostComparisonResponse {
  order_id: number;
  currency: string;
  routes: RouteCostSummaryResponse[];
}
