declare module "pathfinding" {
  export class Grid {
    constructor(width: number, height: number);
    setWalkableAt(x: number, y: number, walkable: boolean): void;
    isWalkableAt(x: number, y: number): boolean;
    clone(): Grid;
  }

  export class AStarFinder {
    constructor(options?: {
      allowDiagonal?: boolean;
      dontCrossCorners?: boolean;
    });
    findPath(
      fromX: number,
      fromY: number,
      toX: number,
      toY: number,
      grid: Grid
    ): [number, number][];
  }
}
