import { pool } from "../database";
import { listFollowedDriverIds } from "./follow.service";

export interface ReceiverSummary {
  id: number;
  full_name: string;
  phone: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export interface DriverSummary {
  id: number;
  full_name: string;
  company_name: string;
  phone: string;
  trustworthiness: number;
  zone_count: number;
  followed: boolean;
  transport_modes: string[];
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function listReceivers(): Promise<ReceiverSummary[]> {
  const result = await pool.query(
    `SELECT id, full_name, phone, address, lat, lng
     FROM users
     WHERE role = 'receiver' AND is_active = TRUE
     ORDER BY full_name ASC`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    full_name: String(row.full_name),
    phone: String(row.phone ?? ""),
    address: String(row.address ?? ""),
    lat: nullableNumber(row.lat),
    lng: nullableNumber(row.lng),
  }));
}

export async function listDrivers(viewerUserId: number): Promise<DriverSummary[]> {
  // Run both queries in parallel — one full RTT instead of two.
  const [followedIds, result] = await Promise.all([
    listFollowedDriverIds(viewerUserId),
    pool.query(
      `SELECT u.id, u.full_name, u.company_name, u.phone, u.trustworthiness,
              COUNT(z.id) AS zone_count,
              COALESCE(ARRAY_AGG(DISTINCT z.transport_mode) FILTER (WHERE z.transport_mode IS NOT NULL), '{}'::TEXT[]) AS transport_modes
       FROM users u
       LEFT JOIN driver_zones z ON z.owner_user_id = u.id
       WHERE u.role = 'driver' AND u.is_active = TRUE
       GROUP BY u.id
       ORDER BY u.trustworthiness DESC, u.full_name ASC`
    ),
  ]);
  const followed = new Set(followedIds);

  return result.rows.map((row) => ({
    id: Number(row.id),
    full_name: String(row.full_name),
    company_name: String(row.company_name ?? ""),
    phone: String(row.phone ?? ""),
    trustworthiness: Number(row.trustworthiness ?? 0),
    zone_count: Number(row.zone_count ?? 0),
    followed: followed.has(Number(row.id)),
    transport_modes: Array.isArray(row.transport_modes)
      ? row.transport_modes.map((m: unknown) => String(m)).filter((m: string) => m.length > 0)
      : [],
  }));
}
