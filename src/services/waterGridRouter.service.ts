import { AStarFinder, Grid } from "pathfinding";
import type { LatLng } from "./landMask.service";
import { isOnLand, segmentCrossesLand } from "./landMask.service";

const finder = new AStarFinder({
  allowDiagonal: true,
  dontCrossCorners: true,
});

function bboxAround(a: LatLng, b: LatLng, padDeg: number) {
  return {
    minLat: Math.min(a.lat, b.lat) - padDeg,
    maxLat: Math.max(a.lat, b.lat) + padDeg,
    minLng: Math.min(a.lng, b.lng) - padDeg,
    maxLng: Math.max(a.lng, b.lng) + padDeg,
  };
}

function chooseStepDeg(a: LatLng, b: LatLng): number {
  const dist = Math.hypot(a.lat - b.lat, a.lng - b.lng);
  if (dist < 0.3) return 0.02;
  if (dist < 1.5) return 0.04;
  return 0.08;
}

function latLngToGrid(
  point: LatLng,
  bbox: ReturnType<typeof bboxAround>,
  step: number,
  cols: number,
  rows: number
): { x: number; y: number } | null {
  const x = Math.round((point.lng - bbox.minLng) / step);
  const y = Math.round((bbox.maxLat - point.lat) / step);
  if (x < 0 || y < 0 || x >= cols || y >= rows) return null;
  return { x, y };
}

function gridToLatLng(
  x: number,
  y: number,
  bbox: ReturnType<typeof bboxAround>,
  step: number
): LatLng {
  return {
    lat: bbox.maxLat - y * step,
    lng: bbox.minLng + x * step,
  };
}

/**
 * A* over a local water-only grid. Land cells are blocked; open sea and
 * coarse estuaries (wider than ~110m land resolution) remain walkable.
 */
export function routeOnWaterGrid(start: LatLng, end: LatLng): LatLng[] | null {
  const pad = 0.35;
  const bbox = bboxAround(start, end, pad);
  const step = chooseStepDeg(start, end);
  const cols = Math.max(8, Math.ceil((bbox.maxLng - bbox.minLng) / step) + 1);
  const rows = Math.max(8, Math.ceil((bbox.maxLat - bbox.minLat) / step) + 1);

  if (cols * rows > 250_000) return null;

  const grid = new Grid(cols, rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = gridToLatLng(x, y, bbox, step);
      const walkable = !isOnLand(cell);
      grid.setWalkableAt(x, y, walkable);
    }
  }

  let startCell = latLngToGrid(start, bbox, step, cols, rows);
  let endCell = latLngToGrid(end, bbox, step, cols, rows);

  if (!startCell || !grid.isWalkableAt(startCell.x, startCell.y)) {
    startCell = findNearestWalkable(start, bbox, step, cols, rows, grid) ?? startCell;
  }
  if (!endCell || !grid.isWalkableAt(endCell.x, endCell.y)) {
    endCell = findNearestWalkable(end, bbox, step, cols, rows, grid) ?? endCell;
  }
  if (!startCell || !endCell) return null;

  const path = finder.findPath(startCell.x, startCell.y, endCell.x, endCell.y, grid.clone());
  if (!path.length) return null;

  const coords = path.map((cell: [number, number]) =>
    gridToLatLng(cell[0], cell[1], bbox, step)
  );
  coords[0] = start;
  coords[coords.length - 1] = end;
  return dedupeLatLngs(coords);
}

function findNearestWalkable(
  target: LatLng,
  bbox: ReturnType<typeof bboxAround>,
  step: number,
  cols: number,
  rows: number,
  grid: Grid
): { x: number; y: number } | null {
  const origin = latLngToGrid(target, bbox, step, cols, rows);
  if (!origin) return null;
  const maxRadius = Math.max(cols, rows);
  for (let r = 1; r < maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if (grid.isWalkableAt(x, y)) return { x, y };
      }
    }
  }
  return null;
}

/**
 * Connect two points without crossing land. Uses a direct segment when safe,
 * otherwise A* on a local water grid.
 */
export function routeWaterSegment(from: LatLng, to: LatLng): LatLng[] | null {
  if (!segmentCrossesLand(from, to)) {
    return dedupeLatLngs([from, to]);
  }
  return routeOnWaterGrid(from, to);
}

function dedupeLatLngs(points: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.lat - p.lat) < 1e-6 && Math.abs(prev.lng - p.lng) < 1e-6) {
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Merge multiple path segments into one coordinate list. */
export function mergePaths(segments: LatLng[][]): LatLng[] {
  const out: LatLng[] = [];
  for (const seg of segments) {
    for (const p of seg) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.lat - p.lat) < 1e-5 && Math.abs(prev.lng - p.lng) < 1e-5) {
        continue;
      }
      out.push(p);
    }
  }
  return out;
}

/** Ensure every consecutive pair in the path does not cross land. */
export function repairLandCrossings(path: LatLng[]): LatLng[] {
  if (path.length < 2) return path;
  const out: LatLng[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const from = out[out.length - 1];
    const to = path[i];
    if (!segmentCrossesLand(from, to)) {
      out.push(to);
      continue;
    }
    const detour = routeOnWaterGrid(from, to);
    if (!detour || detour.length < 2) {
      out.push(to);
      continue;
    }
    for (let j = 1; j < detour.length; j++) out.push(detour[j]);
  }
  return out;
}
