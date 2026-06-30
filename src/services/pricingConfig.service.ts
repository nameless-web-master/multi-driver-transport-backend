import { pool } from "../database";
import {
  PRICING_DEFAULTS,
  PRICING_SETTING_KEYS,
  type PricingConfigResponse,
  type UpdatePricingConfigRequest,
} from "../models/pricingConfig.model";
import { DEFAULT_BOOKING_FEE_RATE, DEFAULT_LAND_SPEED_KMH } from "../models/pricing.model";
import { getLandDistanceProvider } from "./roadRouting.service";
import { isExternalQuoteConfigured } from "./externalQuote.service";

type Cache = { bookingFeeRate: number; landSpeedKmh: number; pffFactor: number; loadedAt: number };
const CACHE_TTL_MS = 60_000;
let cache: Cache | null = null;

function parseRate(raw: string | null | undefined, max = 1): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return n;
}

function parsePositive(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return n;
}

export function clearPricingConfigCache(): void {
  cache = null;
}

async function readSetting(key: string): Promise<string | null> {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = $1`, [key]);
    const v = result.rows[0]?.value;
    return v == null ? null : String(v);
  } catch {
    return null;
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

async function loadCache(): Promise<Cache> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache;

  const bookingFromDb = parseRate(await readSetting(PRICING_SETTING_KEYS.booking_fee_rate));
  const landFromDb = parsePositive(await readSetting(PRICING_SETTING_KEYS.land_speed_kmh));
  const pffFromDb = parseRate(await readSetting(PRICING_SETTING_KEYS.pff_factor));
  const bookingFromEnv = parseRate(process.env.BOOKING_FEE_RATE);
  const landFromEnv = parsePositive(process.env.LAND_SPEED_KMH);
  const pffFromEnv = parseRate(process.env.PFF_FACTOR);

  cache = {
    bookingFeeRate: bookingFromDb ?? bookingFromEnv ?? DEFAULT_BOOKING_FEE_RATE,
    landSpeedKmh: landFromDb ?? landFromEnv ?? DEFAULT_LAND_SPEED_KMH,
    pffFactor: pffFromDb ?? pffFromEnv ?? PRICING_DEFAULTS.pff_factor,
    loadedAt: now,
  };
  return cache;
}

export async function getBookingFeeRate(): Promise<number> {
  return (await loadCache()).bookingFeeRate;
}

export async function getLandSpeedKmh(): Promise<number> {
  return (await loadCache()).landSpeedKmh;
}

export async function getPffFactor(): Promise<number> {
  return (await loadCache()).pffFactor;
}

export async function getPricingConfig(): Promise<PricingConfigResponse> {
  const c = await loadCache();
  return {
    booking_fee_rate: c.bookingFeeRate,
    land_speed_kmh: c.landSpeedKmh,
    pff_factor: c.pffFactor,
    units: PRICING_DEFAULTS.units,
    land_distance_provider: getLandDistanceProvider(),
    external_quote_configured: isExternalQuoteConfigured(),
  };
}

export async function updatePricingConfig(
  data: UpdatePricingConfigRequest
): Promise<PricingConfigResponse> {
  if (data.booking_fee_rate != null) {
    if (!Number.isFinite(data.booking_fee_rate) || data.booking_fee_rate < 0 || data.booking_fee_rate > 1) {
      throw new Error("booking_fee_rate must be between 0 and 1");
    }
    await writeSetting(PRICING_SETTING_KEYS.booking_fee_rate, String(data.booking_fee_rate));
  }
  if (data.land_speed_kmh != null) {
    if (!Number.isFinite(data.land_speed_kmh) || data.land_speed_kmh <= 0) {
      throw new Error("land_speed_kmh must be greater than 0");
    }
    await writeSetting(PRICING_SETTING_KEYS.land_speed_kmh, String(data.land_speed_kmh));
  }
  if (data.pff_factor != null) {
    if (!Number.isFinite(data.pff_factor) || data.pff_factor < 0 || data.pff_factor > 1) {
      throw new Error("pff_factor must be between 0 and 1");
    }
    await writeSetting(PRICING_SETTING_KEYS.pff_factor, String(data.pff_factor));
  }
  clearPricingConfigCache();
  return getPricingConfig();
}
