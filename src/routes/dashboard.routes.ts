import { Response, Router } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { DriverZoneResponse } from "../schemas/driverZone.schema";
import { listDriverZones } from "../services/driverZone.service";

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get("/stats", async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const zones = await listDriverZones();

    const totalH3Cells = zones.reduce((sum, z) => sum + z.cell_count, 0);
    const uniqueDrivers = new Set(zones.map((z) => z.driver_name.toLowerCase())).size;

    const recentZones: DriverZoneResponse[] = zones.slice(0, 5);

    res.json({
      total_driver_zones: zones.length,
      total_h3_cells: totalH3Cells,
      total_drivers: uniqueDrivers,
      total_routes: 0,
      recent_zones: recentZones,
      milestone: 1,
      milestone_total: 7,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load dashboard stats";
    res.status(500).json({ error: message });
  }
});

/** Lightweight health check for authenticated sessions. */
dashboardRouter.get("/ping", async (req: AuthenticatedRequest, res: Response) => {
  res.json({ ok: true, user_id: req.userId });
});
