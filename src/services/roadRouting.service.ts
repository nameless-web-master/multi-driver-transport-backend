import { calculateSegmentDistanceH3 } from "./costCalculation.service";

export type LandDistanceSource = "google" | "h3";

export interface LandLegRoute {
  distance_km: number | null;
  duration_hours: number | null;
  source: LandDistanceSource;
}

const routeCache = new Map<string, LandLegRoute>();

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cacheKey(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): string {
  return `${fromLat.toFixed(5)},${fromLng.toFixed(5)}->${toLat.toFixed(5)},${toLng.toFixed(5)}`;
}


export function getLandDistanceProvider(): LandDistanceSource {
  const raw = (process.env.LAND_DISTANCE_PROVIDER ?? "google").trim().toLowerCase();
  if (raw === "h3") return "h3";
  if (process.env.GOOGLE_MAPS_API_KEY?.trim()) return "google";
  return "h3";
}

function h3Leg(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  resolution?: number
): LandLegRoute {
  const d = calculateSegmentDistanceH3(fromLat, fromLng, toLat, toLng, resolution);
  return {
    distance_km: d.distance_km,
    duration_hours: null,
    source: "h3",
  };
}

interface GoogleDirectionsResponse {
  status: string;
  routes?: Array<{
    legs?: Array<{
      distance?: { value?: number };
      duration?: { value?: number };
    }>;
  }>;
  error_message?: string;
}

async function googleLeg(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<LandLegRoute | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) return null;

  const origin = `${fromLat},${fromLng}`;
  const destination = `${toLat},${toLng}`;
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) return null;

  const data = (await res.json()) as GoogleDirectionsResponse;
  if (data.status !== "OK" || !data.routes?.[0]?.legs?.[0]) {
    console.warn("[road-routing] Google Directions failed:", data.status, data.error_message ?? "");
    return null;
  }

  const leg = data.routes[0].legs[0];
  const meters = leg.distance?.value;
  const seconds = leg.duration?.value;
  if (meters == null || !Number.isFinite(meters)) return null;

  return {
    distance_km: round2(meters / 1000),
    duration_hours:
      seconds != null && Number.isFinite(seconds) ? round2(seconds / 3600) : null,
    source: "google",
  };
}

/**
 * Road distance for a land leg. Uses Google Directions when configured, else H3 estimate.
 */
export async function resolveLandLegRoute(
  fromLat: number | null,
  fromLng: number | null,
  toLat: number | null,
  toLng: number | null,
  resolution?: number
): Promise<LandLegRoute> {
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
    return { distance_km: null, duration_hours: null, source: "h3" };
  }

  const key = cacheKey(fromLat, fromLng, toLat, toLng);
  const cached = routeCache.get(key);
  if (cached) return cached;

  const fLat = fromLat;
  const fLng = fromLng;
  const tLat = toLat;
  const tLng = toLng;

  let result: LandLegRoute;
  if (getLandDistanceProvider() === "google") {
    const google = await googleLeg(fLat, fLng, tLat, tLng);
    result = google ?? h3Leg(fLat, fLng, tLat, tLng, resolution);
  } else {
    result = h3Leg(fLat, fLng, tLat, tLng, resolution);
  }

  routeCache.set(key, result);
  return result;
}

export function clearRoadRouteCache(): void {
  routeCache.clear();
}
