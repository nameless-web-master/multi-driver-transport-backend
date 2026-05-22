import { Response, Router } from "express";
import { pool } from "../database";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { DriverZoneResponse } from "../schemas/driverZone.schema";
import { listDriverZones } from "../services/driverZone.service";

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get("/stats", async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  const role = req.userRole ?? "sender";
  try {
    if (role === "driver") {
      // Fire all three queries concurrently. With a remote DB this turns
      // ~3x the network round-trip into ~1x.
      const [zones, trustRow, followers] = await Promise.all([
        listDriverZones({ userId, role }),
        pool.query(`SELECT trustworthiness FROM users WHERE id = $1`, [userId]),
        pool.query(
          `SELECT COUNT(*)::int AS followers FROM follows WHERE driver_user_id = $1`,
          [userId]
        ),
      ]);
      const totalCells = zones.reduce((sum, z) => sum + z.cell_count, 0);
      const availableZones = zones.filter((z) => z.available).length;
      const recentZones: DriverZoneResponse[] = zones.slice(0, 5);
      res.json({
        role,
        total_driver_zones: zones.length,
        available_zones: availableZones,
        total_h3_cells: totalCells,
        trustworthiness: Number(trustRow.rows[0]?.trustworthiness ?? 0),
        followers: Number(followers.rows[0]?.followers ?? 0),
        recent_zones: recentZones,
      });
      return;
    }

    if (role === "sender") {
      const [orders, drivers, receivers] = await Promise.all([
        pool.query(
          `SELECT status, COUNT(*)::int AS count
           FROM orders WHERE sender_user_id = $1 GROUP BY status`,
          [userId]
        ),
        pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'driver' AND is_active`),
        pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'receiver' AND is_active`),
      ]);
      const counts: Record<string, number> = { submitted: 0, delivering: 0, received: 0 };
      orders.rows.forEach((r) => (counts[String(r.status)] = Number(r.count)));
      res.json({
        role,
        order_counts: counts,
        total_orders: counts.submitted + counts.delivering + counts.received,
        available_drivers: Number(drivers.rows[0]?.c ?? 0),
        available_receivers: Number(receivers.rows[0]?.c ?? 0),
      });
      return;
    }

    // receiver
    const orders = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM orders WHERE receiver_user_id = $1 GROUP BY status`,
      [userId]
    );
    const counts: Record<string, number> = { submitted: 0, delivering: 0, received: 0 };
    orders.rows.forEach((r) => (counts[String(r.status)] = Number(r.count)));
    res.json({
      role,
      order_counts: counts,
      total_orders: counts.submitted + counts.delivering + counts.received,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load dashboard stats";
    res.status(500).json({ error: message });
  }
});

dashboardRouter.get("/ping", async (req: AuthenticatedRequest, res: Response) => {
  res.json({ ok: true, user_id: req.userId });
});
