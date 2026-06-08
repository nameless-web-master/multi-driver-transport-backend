import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { listConnectionFiltersSchema } from "../schemas/zoneConnection.schema";
import {
  deactivateConnection,
  getZoneConnectionById,
  listConnectionsForZone,
  listZoneConnections,
  recalculateAllZoneConnections,
  recalculateConnectionsForZone,
  type ZoneConnectionAccess,
} from "../services/zoneConnection.service";

export const zoneConnectionsRouter = Router();

zoneConnectionsRouter.use(requireAuth);

function accessCtx(req: AuthenticatedRequest): ZoneConnectionAccess {
  return {
    userId: req.userId!,
    role: req.userRole ?? "sender",
  };
}

function fail(res: Response, err: unknown, fallbackStatus = 500) {
  const message = err instanceof Error ? err.message : "Zone connection operation failed";
  console.error("[zone-connections]", err);
  res.status(fallbackStatus).json({ error: message });
}

/**
 * GET /api/zone-connections
 * Filters: ?connection_type=overlap|adjacent, ?transport_id=, ?zone_id=
 *
 * Access: admins & sender/receiver see all active connections; drivers
 * see only the ones touching their own zones.
 */
zoneConnectionsRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = listConnectionFiltersSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid filter",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const connections = await listZoneConnections(accessCtx(req), parsed.data);
    res.json(connections);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/zone-connections/recalculate
 * Wipes and rebuilds the entire zone-connection graph. Allowed for
 * admin and driver roles (drivers may want to manually rebuild when
 * fixing data; senders/receivers are read-only consumers).
 */
zoneConnectionsRouter.post("/recalculate", async (req: AuthenticatedRequest, res: Response) => {
  const ctx = accessCtx(req);
  if (ctx.role !== "admin" && ctx.role !== "driver") {
    return res.status(403).json({ error: "Only admins and drivers can recalculate connections" });
  }
  try {
    const stats = await recalculateAllZoneConnections();
    res.json({
      message: "Zone connections recalculated",
      total_connections: stats.total_connections,
      overlap_connections: stats.overlap_connections,
      adjacent_connections: stats.adjacent_connections,
      hub_connections: stats.hub_connections,
      zones_compared: stats.zones_compared,
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * GET /api/zone-connections/:id
 * Full details for one connection, including the full transfer cell set
 * and adjacent pair list.
 */
zoneConnectionsRouter.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid connection id" });
  }
  try {
    const connection = await getZoneConnectionById(id, accessCtx(req));
    if (!connection) return res.status(404).json({ error: "Connection not found" });
    res.json(connection);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * DELETE /api/zone-connections/:id
 * Soft-delete a connection (is_active = FALSE). It will reappear if the
 * underlying geometry still warrants a connection at the next recalc.
 */
zoneConnectionsRouter.delete("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid connection id" });
  }
  try {
    const ok = await deactivateConnection(id, accessCtx(req));
    if (!ok) return res.status(404).json({ error: "Connection not found or not permitted" });
    res.status(204).send();
  } catch (err) {
    fail(res, err);
  }
});

// --------------------------------------------------------------------------
// Per-zone helpers — mounted under the same router for tighter cohesion,
// but main.ts also exposes them under /api/zones/:id/... for the spec
// path shape.
// --------------------------------------------------------------------------

export const zonesScopedConnectionsRouter = Router();
zonesScopedConnectionsRouter.use(requireAuth);

/**
 * GET /api/zones/:zoneId/connections
 * List every connection that includes the given zone.
 */
zonesScopedConnectionsRouter.get(
  "/:zoneId/connections",
  async (req: AuthenticatedRequest, res: Response) => {
    const zoneId = Number(req.params.zoneId);
    if (!Number.isInteger(zoneId) || zoneId < 1) {
      return res.status(400).json({ error: "Invalid zone id" });
    }
    try {
      const items = await listConnectionsForZone(zoneId, accessCtx(req));
      res.json(items);
    } catch (err) {
      fail(res, err);
    }
  }
);

/**
 * POST /api/zones/:zoneId/detect-connections
 * Incremental recalculation for a single zone (cheaper than a full
 * recalc). Permitted for admin and the driver who owns the zone.
 */
zonesScopedConnectionsRouter.post(
  "/:zoneId/detect-connections",
  async (req: AuthenticatedRequest, res: Response) => {
    const zoneId = Number(req.params.zoneId);
    if (!Number.isInteger(zoneId) || zoneId < 1) {
      return res.status(400).json({ error: "Invalid zone id" });
    }
    const ctx = accessCtx(req);
    if (ctx.role !== "admin" && ctx.role !== "driver") {
      return res.status(403).json({ error: "Only admins and drivers can recalculate" });
    }
    try {
      const stats = await recalculateConnectionsForZone(zoneId);
      res.json({
        message: "Zone connections recalculated for zone",
        zone_id: zoneId,
        ...stats,
      });
    } catch (err) {
      fail(res, err);
    }
  }
);
