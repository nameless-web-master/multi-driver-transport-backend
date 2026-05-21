import {
  latLngToCell,
  cellToLatLng,
  cellToBoundary,
  isValidCell,
  getResolution,
  gridDisk,
  polygonToCells,
} from "h3-js";

/**
 * Central H3 service.
 *
 * All H3 algorithm calls flow through this module so that future milestones
 * (overlap detection, adjacency graph, multi-driver paths, transfer zones)
 * can build on a single, consistent geospatial primitive layer.
 */

export type LatLng = { lat: number; lng: number };

export type CellBoundary = LatLng[];

export const H3_RESOLUTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
export type H3Resolution = (typeof H3_RESOLUTIONS)[number];

export function isValidResolution(value: unknown): value is H3Resolution {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 15;
}

export function isH3Cell(value: unknown): value is string {
  return typeof value === "string" && isValidCell(value);
}

export function pointToCell(lat: number, lng: number, resolution: H3Resolution): string {
  return latLngToCell(lat, lng, resolution);
}

export function cellCenter(cell: string): LatLng {
  const [lat, lng] = cellToLatLng(cell);
  return { lat, lng };
}

export function cellBoundary(cell: string): CellBoundary {
  return cellToBoundary(cell).map(([lat, lng]) => ({ lat, lng }));
}

export function cellResolution(cell: string): number {
  return getResolution(cell);
}

/**
 * Neighbouring cells within k steps – useful in later milestones for
 * adjacency / transfer-zone detection. Exposed now so the API surface is
 * future-proof.
 */
export function neighbours(cell: string, k = 1): string[] {
  return gridDisk(cell, k);
}

export function polygonCells(
  boundary: LatLng[],
  resolution: H3Resolution
): string[] {
  const ring = boundary.map(({ lat, lng }) => [lat, lng] as [number, number]);
  return polygonToCells(ring, resolution);
}

/** Normalize/dedupe a list of incoming H3 IDs and validate them. */
export function sanitizeCells(cells: string[]): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of cells) {
    const cell = String(raw).trim().toLowerCase();
    if (!cell) continue;
    if (seen.has(cell)) continue;
    seen.add(cell);
    if (isValidCell(cell)) valid.push(cell);
    else invalid.push(cell);
  }
  return { valid, invalid };
}
