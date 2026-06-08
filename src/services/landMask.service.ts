import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
export interface LatLng {
  lat: number;
  lng: number;
}

type LandFeature = Feature<Polygon | MultiPolygon>;

let landCollection: FeatureCollection<Polygon | MultiPolygon> | null = null;
let landFeatures: LandFeature[] = [];

function resolveLandDataPath(): string {
  const candidates = [
    path.join(__dirname, "../../data/ne_110m_land.geojson"),
    path.join(process.cwd(), "data/ne_110m_land.geojson"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Land polygon data not found (data/ne_110m_land.geojson)");
}

/** Load Natural Earth 110m land polygons once at startup. */
export function ensureLandMaskLoaded(): void {
  if (landCollection) return;
  const raw = fs.readFileSync(resolveLandDataPath(), "utf8");
  landCollection = JSON.parse(raw) as FeatureCollection<Polygon | MultiPolygon>;
  landFeatures = landCollection.features;
}

/** True when the point lies on land (coarse 110m resolution). */
export function isOnLand(point: LatLng): boolean {
  ensureLandMaskLoaded();
  const pt = turf.point([point.lng, point.lat]);
  for (const feature of landFeatures) {
    if (turf.booleanPointInPolygon(pt, feature)) return true;
  }
  return false;
}

function bboxesOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

/** True when the straight segment between two points crosses any land polygon. */
export function segmentCrossesLand(from: LatLng, to: LatLng): boolean {
  ensureLandMaskLoaded();
  const line = turf.lineString([
    [from.lng, from.lat],
    [to.lng, to.lat],
  ]);
  const lineBbox = turf.bbox(line) as [number, number, number, number];
  for (const feature of landFeatures) {
    const fb = turf.bbox(feature) as [number, number, number, number];
    if (!bboxesOverlap(lineBbox, fb)) continue;
    if (turf.booleanIntersects(line, feature)) return true;
  }
  return false;
}

/**
 * Nearest open-water point around a port. Inland / estuary ports sit inside
 * coarse land polygons, so we search outward in rings until we hit water.
 */
export function findNearestWater(
  port: LatLng,
  maxRadiusDeg = 2.5,
  stepDeg = 0.05
): LatLng | null {
  if (!isOnLand(port)) return port;

  const latScale = Math.cos((port.lat * Math.PI) / 180);
  for (let r = stepDeg; r <= maxRadiusDeg; r += stepDeg) {
    const samples = Math.max(16, Math.ceil((2 * Math.PI * r) / stepDeg));
    for (let i = 0; i < samples; i++) {
      const angle = (2 * Math.PI * i) / samples;
      const candidate: LatLng = {
        lat: port.lat + r * Math.cos(angle),
        lng: port.lng + (r * Math.sin(angle)) / Math.max(latScale, 0.2),
      };
      if (!isOnLand(candidate)) return candidate;
    }
  }
  return null;
}
