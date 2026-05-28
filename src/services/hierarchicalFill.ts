import {
  cellToBoundary,
  cellToChildren,
  getResolution,
  polygonToCells,
} from "h3-js";
import type { H3Resolution, LatLng } from "./h3_service";

/** Average H3 hex area (km²) by resolution — used to pick a coarse start level. */
const H3_AVG_AREA_KM2: Record<number, number> = {
  0: 4_357_449.4,
  1: 609_788.4,
  2: 86_801.8,
  3: 12_393.4,
  4: 1_770.32,
  5: 252.903,
  6: 36.129,
  7: 5.16129,
  8: 0.73733,
  9: 0.10533,
  10: 0.015047,
  11: 0.00215,
  12: 0.000307,
  13: 0.0000439,
  14: 0.00000627,
  15: 0.00000089,
};

export interface HierarchicalFillOptions {
  maxRes: H3Resolution;
  minRes?: H3Resolution;
  maxCells?: number;
}

export interface HierarchicalFillResult {
  cells: string[];
  cellCount: number;
  minResolution: number;
  maxResolution: number;
}

function polygonAreaKm2(boundary: LatLng[]): number {
  if (boundary.length < 3) return 0;
  const R = 6371;
  let sum = 0;
  const n = boundary.length;
  for (let i = 0; i < n; i++) {
    const p1 = boundary[i];
    const p2 = boundary[(i + 1) % n];
    const lng1 = (p1.lng * Math.PI) / 180;
    const lng2 = (p2.lng * Math.PI) / 180;
    const lat1 = (p1.lat * Math.PI) / 180;
    const lat2 = (p2.lat * Math.PI) / 180;
    sum += (lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((sum * R * R) / 2);
}

/** Coarsest resolution that keeps a flat fill under ~2× the cell budget. */
function chooseStartResolution(
  areaKm2: number,
  maxRes: number,
  maxCells: number,
  minRes: number
): number {
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) {
    return Math.max(minRes, maxRes - 2);
  }
  for (let r = minRes; r <= maxRes; r++) {
    const avg = H3_AVG_AREA_KM2[r];
    if (avg && areaKm2 / avg <= maxCells * 2) {
      return Math.max(minRes, r);
    }
  }
  return minRes;
}

function ringFromBoundary(boundary: LatLng[]): [number, number][] {
  return boundary.map(({ lat, lng }) => [lat, lng] as [number, number]);
}

/** Ray-casting point-in-polygon; ring vertices are [lat, lng]. */
function pointInRing(lat: number, lng: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function cellFullyInside(ring: [number, number][], cell: string): boolean {
  const verts = cellToBoundary(cell);
  return verts.every(([lat, lng]) => pointInRing(lat, lng, ring));
}

function cellIntersectsPolygon(ring: [number, number][], cell: string): boolean {
  if (cellFullyInside(ring, cell)) return true;
  const verts = cellToBoundary(cell);
  if (verts.some(([lat, lng]) => pointInRing(lat, lng, ring))) return true;
  const centerLat = verts.reduce((s, v) => s + v[0], 0) / verts.length;
  const centerLng = verts.reduce((s, v) => s + v[1], 0) / verts.length;
  return pointInRing(centerLat, centerLng, ring);
}

/**
 * Fill a polygon with H3 cells using multiple resolutions: interior regions
 * stay coarse; boundary regions subdivide up to `maxRes`. Keeps cell count
 * low for large geofences while preserving detail along edges.
 */
export function hierarchicalPolygonCells(
  boundary: LatLng[],
  options: HierarchicalFillOptions
): HierarchicalFillResult {
  const maxRes = options.maxRes;
  const minRes = options.minRes ?? 0;
  const maxCells = options.maxCells ?? 8000;

  const ring = ringFromBoundary(boundary);
  if (ring.length < 3) {
    throw new Error("boundary must have at least 3 points");
  }

  const area = polygonAreaKm2(boundary);
  const startRes = chooseStartResolution(area, maxRes, maxCells, minRes);

  const result: string[] = [];
  const seen = new Set<string>();

  type QueueItem = { cell: string; res: number };
  const queue: QueueItem[] = polygonToCells(ring, startRes).map((cell) => ({
    cell,
    res: getResolution(cell),
  }));

  while (queue.length > 0 && result.length < maxCells) {
    const { cell, res } = queue.shift()!;
    if (res > maxRes) continue;
    if (!cellIntersectsPolygon(ring, cell)) continue;

    if (res >= maxRes || cellFullyInside(ring, cell)) {
      if (!seen.has(cell)) {
        seen.add(cell);
        result.push(cell);
      }
      continue;
    }

    const childRes = (res + 1) as H3Resolution;
    const children = cellToChildren(cell, childRes);
    for (const child of children) {
      queue.push({ cell: child, res: childRes });
    }
  }

  if (result.length === 0) {
    throw new Error("Geofence boundary produced no H3 cells");
  }

  if (result.length >= maxCells) {
    throw new Error(
      `Geofence is too large (>${maxCells} cells). Use a coarser max resolution or a smaller area.`
    );
  }

  const resolutions = result.map((c) => getResolution(c));
  return {
    cells: result,
    cellCount: result.length,
    minResolution: Math.min(...resolutions),
    maxResolution: Math.max(...resolutions),
  };
}
