import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import {
  createDriverZoneSchema,
  updateDriverZoneSchema,
} from "../schemas/driverZone.schema";
import {
  createDriverZoneFromRequest,
  deleteDriverZone,
  getDriverZoneById,
  listDriverZones,
  updateDriverZoneFromRequest,
  ZoneAccessContext,
} from "../services/driverZone.service";

export const driverZonesRouter = Router();

driverZonesRouter.use(requireAuth);

function accessCtx(req: AuthenticatedRequest): ZoneAccessContext {
  return {
    userId: req.userId!,
    role: req.userRole ?? "sender",
  };
}

function requireDriverOrAdmin(ctx: ZoneAccessContext, res: Response): boolean {
  if (ctx.role !== "driver" && ctx.role !== "admin") {
    res.status(403).json({ error: "Only drivers can manage zones" });
    return false;
  }
  return true;
}

driverZonesRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const ctx = accessCtx(req);
  try {
    const ownerParam = req.query.owner_user_id;
    const ownerUserId = typeof ownerParam === "string" && ownerParam ? Number(ownerParam) : undefined;
    const availableParam = req.query.available;
    // Per spec, senders see all zones. They can opt into ?available=true for a filtered view.
    const availableOnly = availableParam === "true" || availableParam === "1";
    const zones = await listDriverZones(ctx, {
      availableOnly,
      ownerUserId: Number.isFinite(ownerUserId) ? ownerUserId : undefined,
    });
    res.json(zones);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list zones";
    res.status(500).json({ error: message });
  }
});

driverZonesRouter.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid zone id" });
  }
  try {
    const zone = await getDriverZoneById(id, accessCtx(req));
    if (!zone) return res.status(404).json({ error: "Driver zone not found" });
    res.json(zone);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch zone";
    res.status(500).json({ error: message });
  }
});

driverZonesRouter.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const ctx = accessCtx(req);
  if (!requireDriverOrAdmin(ctx, res)) return;
  const parsed = createDriverZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const zone = await createDriverZoneFromRequest(req.userId!, parsed.data);
    res.status(201).json(zone);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create zone";
    res.status(400).json({ error: message });
  }
});

driverZonesRouter.put("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const ctx = accessCtx(req);
  if (!requireDriverOrAdmin(ctx, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid zone id" });
  }
  const parsed = updateDriverZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const zone = await updateDriverZoneFromRequest(id, ctx, parsed.data);
    if (!zone) return res.status(404).json({ error: "Driver zone not found" });
    res.json(zone);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update zone";
    res.status(400).json({ error: message });
  }
});

driverZonesRouter.delete("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const ctx = accessCtx(req);
  if (!requireDriverOrAdmin(ctx, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid zone id" });
  }
  try {
    const deleted = await deleteDriverZone(id, ctx);
    if (!deleted) return res.status(404).json({ error: "Driver zone not found" });
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete zone";
    res.status(500).json({ error: message });
  }
});
