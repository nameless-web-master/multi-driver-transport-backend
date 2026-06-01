import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import {
  componentIdSchema,
  rebuildOptionsSchema,
  zoneIdParamSchema,
} from "../schemas/driverZoneGraph.schema";
import {
  buildGraph,
  getComponentById,
  getGraphSummaryForCtx,
  getNodeDegreeForZone,
  getZoneGraphNeighborhood,
  listComponents,
  listIsolatedZones,
  rebuildGraph,
  type GraphAccess,
} from "../services/driverZoneGraph.service";

export const driverZoneGraphRouter = Router();

driverZoneGraphRouter.use(requireAuth);

function accessCtx(req: AuthenticatedRequest): GraphAccess {
  return {
    userId: req.userId!,
    role: req.userRole ?? "sender",
  };
}

function fail(res: Response, err: unknown, fallbackStatus = 500) {
  const message = err instanceof Error ? err.message : "Graph operation failed";
  console.error("[driver-zone-graph]", err);
  res.status(fallbackStatus).json({ error: message });
}

/**
 * GET /api/driver-zone-graph
 * Returns the full graph: nodes, edges, components, isolated nodes, summary.
 */
driverZoneGraphRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const graph = await buildGraph(accessCtx(req));
    res.json(graph);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/driver-zone-graph/rebuild
 * Rebuilds the graph and returns it. Pass `{ recalculate_connections: true }`
 * to first re-run the Milestone 2 zone-connection recalculation pass.
 *
 * Allowed for admin and driver roles (drivers may want to refresh after
 * editing their own zones). Sender/receiver get a 403 — they can already
 * fetch the current graph via GET / without mutating state.
 */
driverZoneGraphRouter.post("/rebuild", async (req: AuthenticatedRequest, res: Response) => {
  const ctx = accessCtx(req);
  if (ctx.role !== "admin" && ctx.role !== "driver") {
    return res.status(403).json({ error: "Only admins and drivers can rebuild the graph" });
  }
  const parsed = rebuildOptionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid rebuild options",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  // The M2 recalculation underneath is admin/driver only — same gate as
  // POST /api/zone-connections/recalculate.
  try {
    const graph = await rebuildGraph(ctx, parsed.data);
    res.json({
      message: parsed.data.recalculate_connections
        ? "Zone connections recalculated and graph rebuilt"
        : "Graph rebuilt",
      ...graph,
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/driver-zone-graph/summary
 * Lightweight stats only (totals, component count, etc.) for the
 * dashboard tiles.
 */
driverZoneGraphRouter.get("/summary", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const summary = await getGraphSummaryForCtx(accessCtx(req));
    res.json(summary);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/driver-zone-graph/components
 * Returns every connected component (including single-node ones).
 */
driverZoneGraphRouter.get("/components", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const components = await listComponents(accessCtx(req));
    res.json(components);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/driver-zone-graph/components/:component_id
 * Returns one component with its node + edge payload embedded.
 */
driverZoneGraphRouter.get(
  "/components/:component_id",
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = componentIdSchema.safeParse(req.params.component_id);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid component id" });
    }
    try {
      const result = await getComponentById(accessCtx(req), parsed.data);
      if (!result) return res.status(404).json({ error: "Component not found" });
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  }
);

/**
 * GET /api/driver-zone-graph/isolated-zones
 * Zones with no active connections.
 */
driverZoneGraphRouter.get(
  "/isolated-zones",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const isolated = await listIsolatedZones(accessCtx(req));
      res.json(isolated);
    } catch (err) {
      fail(res, err);
    }
  }
);

/**
 * GET /api/driver-zone-graph/zones/:zone_id/neighborhood
 * Returns the zone, its direct neighbours, and the connecting edges.
 */
driverZoneGraphRouter.get(
  "/zones/:zone_id/neighborhood",
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = zoneIdParamSchema.safeParse(req.params.zone_id);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid zone id" });
    }
    try {
      const neighborhood = await getZoneGraphNeighborhood(accessCtx(req), parsed.data);
      if (!neighborhood) return res.status(404).json({ error: "Zone not found in graph" });
      res.json(neighborhood);
    } catch (err) {
      fail(res, err);
    }
  }
);

/**
 * GET /api/driver-zone-graph/zones/:zone_id/degree
 * Number of direct connections this zone has in the graph.
 */
driverZoneGraphRouter.get(
  "/zones/:zone_id/degree",
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = zoneIdParamSchema.safeParse(req.params.zone_id);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid zone id" });
    }
    try {
      const degreeInfo = await getNodeDegreeForZone(accessCtx(req), parsed.data);
      if (!degreeInfo) return res.status(404).json({ error: "Zone not found in graph" });
      res.json(degreeInfo);
    } catch (err) {
      fail(res, err);
    }
  }
);
