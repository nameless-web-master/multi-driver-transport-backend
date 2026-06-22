import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import {
  RouteConfirmationError,
  confirmSegment,
  getRouteConfirmationStatus,
  getSelectedRoute,
  rejectSegment,
  selectRoute,
  sendConfirmationToTransporters,
} from "../services/route_confirmation.service";
import {
  SegmentTrackingError,
  updateSegmentLegStatus,
} from "../services/segment_tracking.service";

export const routeConfirmationRouter = Router();
export const segmentsRouter = Router();

routeConfirmationRouter.use(requireAuth);
segmentsRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest) {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

function handle(res: Response, err: unknown) {
  if (err instanceof RouteConfirmationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SegmentTrackingError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Route confirmation failed";
  console.error("[route-confirmation]", err);
  res.status(500).json({ error: message });
}

const selectRouteSchema = z.object({
  order_id: z.coerce.number().int().positive(),
  route_id: z.coerce.number().int().positive(),
});

const rejectSegmentSchema = z.object({
  reason: z.string().trim().max(500).optional().default(""),
});

const updateLegStatusSchema = z.object({
  leg_status: z.enum(["picked_up", "in_transit"]),
});

routeConfirmationRouter.post("/select", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = selectRouteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const c = ctx(req);
  if (c.role !== "sender" && c.role !== "receiver" && c.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const selection = await selectRoute(
      parsed.data.order_id,
      parsed.data.route_id,
      c.userId,
      c
    );
    res.status(201).json(selection);
  } catch (err) {
    handle(res, err);
  }
});

routeConfirmationRouter.post(
  "/:routeId/send-confirmation",
  async (req: AuthenticatedRequest, res: Response) => {
    const routeId = Number(req.params.routeId);
    if (!Number.isInteger(routeId) || routeId < 1) {
      return res.status(400).json({ error: "Invalid route id" });
    }
    try {
      await sendConfirmationToTransporters(routeId, ctx(req));
      const status = await getRouteConfirmationStatus(routeId, ctx(req));
      res.json(status);
    } catch (err) {
      handle(res, err);
    }
  }
);

routeConfirmationRouter.get(
  "/:routeId/confirmation-status",
  async (req: AuthenticatedRequest, res: Response) => {
    const routeId = Number(req.params.routeId);
    if (!Number.isInteger(routeId) || routeId < 1) {
      return res.status(400).json({ error: "Invalid route id" });
    }
    try {
      const status = await getRouteConfirmationStatus(routeId, ctx(req));
      res.json(status);
    } catch (err) {
      handle(res, err);
    }
  }
);

segmentsRouter.post("/:segmentId/confirm", async (req: AuthenticatedRequest, res: Response) => {
  const segmentId = Number(req.params.segmentId);
  if (!Number.isInteger(segmentId) || segmentId < 1) {
    return res.status(400).json({ error: "Invalid segment id" });
  }
  const c = ctx(req);
  if (c.role !== "driver" && c.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const status = await confirmSegment(segmentId, c.userId, c);
    res.json(status);
  } catch (err) {
    handle(res, err);
  }
});

segmentsRouter.post("/:segmentId/reject", async (req: AuthenticatedRequest, res: Response) => {
  const segmentId = Number(req.params.segmentId);
  if (!Number.isInteger(segmentId) || segmentId < 1) {
    return res.status(400).json({ error: "Invalid segment id" });
  }
  const parsed = rejectSegmentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const c = ctx(req);
  if (c.role !== "driver" && c.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const status = await rejectSegment(segmentId, c.userId, parsed.data.reason, c);
    res.json(status);
  } catch (err) {
    handle(res, err);
  }
});

segmentsRouter.patch("/:segmentId/leg-status", async (req: AuthenticatedRequest, res: Response) => {
  const segmentId = Number(req.params.segmentId);
  if (!Number.isInteger(segmentId) || segmentId < 1) {
    return res.status(400).json({ error: "Invalid segment id" });
  }
  const parsed = updateLegStatusSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const c = ctx(req);
  if (c.role !== "driver" && c.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const result = await updateSegmentLegStatus(segmentId, parsed.data.leg_status, c);
    res.json(result);
  } catch (err) {
    handle(res, err);
  }
});
