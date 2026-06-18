import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { manualSegmentCostSchema } from "../schemas/rateTable.schema";
import {
  RouteCostError,
  applyManualSegmentCost,
  applyExternalSegmentCost,
  fetchExternalSegmentQuote,
  requestSegmentQuote,
  listTransporterQuoteRequests,
  calculateRouteCost,
  compareOrderRoutes,
  getRouteCostSummary,
  getRouteSegmentCosts,
  recalculateRouteCostsForOrder,
} from "../services/routeCost.service";

export const routesCostRouter = Router();
export const routeSegmentCostsRouter = Router();

routesCostRouter.use(requireAuth);
routeSegmentCostsRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest) {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

function handle(res: Response, err: unknown) {
  if (err instanceof RouteCostError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Route cost operation failed";
  console.error("[route-cost]", err);
  res.status(500).json({ error: message });
}

routeSegmentCostsRouter.get("/transporter-queue", async (req: AuthenticatedRequest, res: Response) => {
  const c = ctx(req);
  if (c.role !== "driver" && c.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const items = await listTransporterQuoteRequests(c);
    res.json(items);
  } catch (err) {
    handle(res, err);
  }
});

routesCostRouter.post("/:routeId/calculate-cost", async (req: AuthenticatedRequest, res: Response) => {
  const routeId = Number(req.params.routeId);
  if (!Number.isInteger(routeId) || routeId < 1) {
    return res.status(400).json({ error: "Invalid route id" });
  }
  try {
    const summary = await calculateRouteCost(routeId, ctx(req));
    res.json(summary);
  } catch (err) {
    handle(res, err);
  }
});

routesCostRouter.get("/:routeId/cost-summary", async (req: AuthenticatedRequest, res: Response) => {
  const routeId = Number(req.params.routeId);
  if (!Number.isInteger(routeId) || routeId < 1) {
    return res.status(400).json({ error: "Invalid route id" });
  }
  try {
    const summary = await getRouteCostSummary(routeId, ctx(req));
    res.json(summary);
  } catch (err) {
    handle(res, err);
  }
});

routesCostRouter.get("/:routeId/segment-costs", async (req: AuthenticatedRequest, res: Response) => {
  const routeId = Number(req.params.routeId);
  if (!Number.isInteger(routeId) || routeId < 1) {
    return res.status(400).json({ error: "Invalid route id" });
  }
  try {
    const segments = await getRouteSegmentCosts(routeId, ctx(req));
    res.json(segments);
  } catch (err) {
    handle(res, err);
  }
});

routeSegmentCostsRouter.post(
  "/:segmentCostId/request-quote",
  async (req: AuthenticatedRequest, res: Response) => {
    const segmentCostId = Number(req.params.segmentCostId);
    if (!Number.isInteger(segmentCostId) || segmentCostId < 1) {
      return res.status(400).json({ error: "Invalid segment cost id" });
    }
    try {
      const segment = await requestSegmentQuote(segmentCostId, ctx(req));
      res.json(segment);
    } catch (err) {
      handle(res, err);
    }
  }
);

routeSegmentCostsRouter.post(
  "/:segmentCostId/fetch-external-quote",
  async (req: AuthenticatedRequest, res: Response) => {
    const segmentCostId = Number(req.params.segmentCostId);
    if (!Number.isInteger(segmentCostId) || segmentCostId < 1) {
      return res.status(400).json({ error: "Invalid segment cost id" });
    }
    try {
      const segment = await fetchExternalSegmentQuote(segmentCostId, ctx(req));
      res.json(segment);
    } catch (err) {
      handle(res, err);
    }
  }
);

routeSegmentCostsRouter.post(
  "/:segmentCostId/external-cost",
  async (req: AuthenticatedRequest, res: Response) => {
    const segmentCostId = Number(req.params.segmentCostId);
    if (!Number.isInteger(segmentCostId) || segmentCostId < 1) {
      return res.status(400).json({ error: "Invalid segment cost id" });
    }
    const parsed = manualSegmentCostSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    try {
      const segment = await applyExternalSegmentCost(
        segmentCostId,
        parsed.data.manual_cost,
        ctx(req)
      );
      res.json(segment);
    } catch (err) {
      handle(res, err);
    }
  }
);

routeSegmentCostsRouter.post(
  "/:segmentCostId/manual-cost",
  async (req: AuthenticatedRequest, res: Response) => {
    const segmentCostId = Number(req.params.segmentCostId);
    if (!Number.isInteger(segmentCostId) || segmentCostId < 1) {
      return res.status(400).json({ error: "Invalid segment cost id" });
    }
    const parsed = manualSegmentCostSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    try {
      const segment = await applyManualSegmentCost(
        segmentCostId,
        parsed.data.manual_cost,
        ctx(req)
      );
      res.json(segment);
    } catch (err) {
      handle(res, err);
    }
  }
);
