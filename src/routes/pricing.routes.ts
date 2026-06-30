import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import {
  getPricingConfig,
  updatePricingConfig,
} from "../services/pricingConfig.service";
import {
  createPricingRegion,
  deletePricingRegion,
  listPricingRegions,
  PricingRegionError,
  updatePricingRegion,
} from "../services/pricingRegion.service";
import {
  createPricingRegionSchema,
  updatePricingRegionSchema,
} from "../schemas/pricingRegion.schema";

export const pricingRouter = Router();

pricingRouter.use(requireAuth);

const updateSchema = z.object({
  booking_fee_rate: z.number().min(0).max(1).optional(),
  land_speed_kmh: z.number().positive().max(1_000_000).optional(),
  pff_factor: z.number().min(0).max(1).optional(),
});

pricingRouter.get("/config", async (_req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await getPricingConfig());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load pricing config";
    res.status(500).json({ error: message });
  }
});

pricingRouter.patch("/config", async (req: AuthenticatedRequest, res: Response) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Only admins can update pricing settings" });
  }
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  if (
    parsed.data.booking_fee_rate == null &&
    parsed.data.land_speed_kmh == null &&
    parsed.data.pff_factor == null
  ) {
    return res.status(400).json({ error: "Provide at least one setting to update" });
  }
  try {
    res.json(await updatePricingConfig(parsed.data));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update pricing config";
    res.status(400).json({ error: message });
  }
});

pricingRouter.get("/regions", async (_req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await listPricingRegions());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load pricing regions";
    res.status(500).json({ error: message });
  }
});

pricingRouter.post("/regions", async (req: AuthenticatedRequest, res: Response) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Only admins can manage pricing regions" });
  }
  const parsed = createPricingRegionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    res.status(201).json(await createPricingRegion(parsed.data));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create pricing region";
    const status = err instanceof PricingRegionError ? err.statusCode : 400;
    res.status(status).json({ error: message });
  }
});

pricingRouter.patch("/regions/:id", async (req: AuthenticatedRequest, res: Response) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Only admins can manage pricing regions" });
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid region id" });
  }
  const parsed = updatePricingRegionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    res.json(await updatePricingRegion(id, parsed.data));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update pricing region";
    const status = err instanceof PricingRegionError ? err.statusCode : 400;
    res.status(status).json({ error: message });
  }
});

pricingRouter.delete("/regions/:id", async (req: AuthenticatedRequest, res: Response) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Only admins can manage pricing regions" });
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid region id" });
  }
  try {
    await deletePricingRegion(id);
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete pricing region";
    const status = err instanceof PricingRegionError ? err.statusCode : 400;
    res.status(status).json({ error: message });
  }
});
