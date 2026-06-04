export const ORDER_STATUSES = ["submitted", "delivering", "received"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export interface OrderRow {
  id: number;
  sender_user_id: number;
  receiver_user_id: number;
  driver_user_id: number | null;
  sender_address: string;
  sender_lat: number | null;
  sender_lng: number | null;
  destination_address: string;
  destination_lat: number | null;
  destination_lng: number | null;
  receiver_phone: string;
  notes: string;
  pickup_h3: string | null;
  delivery_h3: string | null;
  h3_resolution: number | null;
  source_name: string;
  source_contact: string;
  payment_method: string;
  shipping_method: string;
  package_description: string;
  weight_kg: number | null;
  dimensions: string;
  status: OrderStatus;
  submitted_at: Date;
  delivering_at: Date | null;
  received_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderResponse {
  id: number;
  sender_user_id: number;
  receiver_user_id: number;
  driver_user_id: number | null;
  sender_name: string;
  sender_phone: string;
  receiver_name: string;
  receiver_phone: string;
  sender_address: string;
  sender_lat: number | null;
  sender_lng: number | null;
  destination_address: string;
  destination_lat: number | null;
  destination_lng: number | null;
  notes: string;
  pickup_h3: string | null;
  delivery_h3: string | null;
  h3_resolution: number | null;
  source_name: string;
  source_contact: string;
  payment_method: string;
  shipping_method: string;
  package_description: string;
  weight_kg: number | null;
  dimensions: string;
  status: OrderStatus;
  submitted_at: string;
  delivering_at: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
}
