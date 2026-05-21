import { Router, Request, Response } from "express";
import { requireAuth } from "../dependencies/auth.middleware";
import {
  createDriverZoneSchema,
  updateDriverZoneSchema,
} from "../schemas/driverZone.schema";
import {
  createDriverZone,
  deleteDriverZone,
  getDriverZoneById,
  listDriverZones,
  updateDriverZone,
} from "../services/driverZone.service";

export const driverZonesRouter = Router();

driverZonesRouter.use(requireAuth);

driverZonesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const zones = await listDriverZones();
    res.json(zones);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list zones";
    res.status(500).json({ error: message });
  }
});

driverZonesRouter.get("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid zone id" });
  }
  try {
    const zone = await getDriverZoneById(id);
    if (!zone) return res.status(404).json({ error: "Driver zone not found" });
    res.json(zone);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch zone";
    res.status(500).json({ error: message });
  }
});

driverZonesRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createDriverZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const zone = await createDriverZone(parsed.data);
    res.status(201).json(zone);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create zone";
    res.status(400).json({ error: message });
  }
});

driverZonesRouter.put("/:id", async (req: Request, res: Response) => {
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
    const zone = await updateDriverZone(id, parsed.data);
    if (!zone) return res.status(404).json({ error: "Driver zone not found" });
    res.json(zone);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update zone";
    res.status(400).json({ error: message });
  }
});

driverZonesRouter.delete("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid zone id" });
  }
  try {
    const deleted = await deleteDriverZone(id);
    if (!deleted) return res.status(404).json({ error: "Driver zone not found" });
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete zone";
    res.status(500).json({ error: message });
  }
});
