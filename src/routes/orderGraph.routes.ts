import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { OrderError, type OrderContext } from "../services/order.service";
import {
  buildOrderGraph,
  getOrderGraphSummary,
  rebuildOrderGraph,
} from "../services/orderGraph.service";

/**
 * Milestone 3 — Order-based transporter graph routes.
 *
 *   GET  /api/order-graph/:orderId          → full graph for the order
 *   POST /api/order-graph/:orderId/build     → (re)build, optional M2 recalc
 *   GET  /api/order-graph/:orderId/summary   → summary only
 */
export const orderGraphRouter = Router();

orderGraphRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest): OrderContext {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

function parseOrderId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function fail(res: Response, err: unknown) {
  if (err instanceof OrderError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Order graph operation failed";
  console.error("[order-graph]", err);
  res.status(500).json({ error: message });
}

const buildOptionsSchema = z
  .object({ recalculate_connections: z.boolean().optional().default(false) })
  .partial()
  .default({});

orderGraphRouter.get("/:orderId", async (req: AuthenticatedRequest, res: Response) => {
  const orderId = parseOrderId(req.params.orderId);
  if (orderId == null) return res.status(400).json({ error: "Invalid order id" });
  try {
    const graph = await buildOrderGraph(ctx(req), orderId);
    res.json(graph);
  } catch (err) {
    fail(res, err);
  }
});

orderGraphRouter.get("/:orderId/summary", async (req: AuthenticatedRequest, res: Response) => {
  const orderId = parseOrderId(req.params.orderId);
  if (orderId == null) return res.status(400).json({ error: "Invalid order id" });
  try {
    const summary = await getOrderGraphSummary(ctx(req), orderId);
    res.json(summary);
  } catch (err) {
    fail(res, err);
  }
});

orderGraphRouter.post("/:orderId/build", async (req: AuthenticatedRequest, res: Response) => {
  const orderId = parseOrderId(req.params.orderId);
  if (orderId == null) return res.status(400).json({ error: "Invalid order id" });

  const parsed = buildOptionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid build options",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const c = ctx(req);
  // Recalculating Milestone-2 connections is a global, admin/driver-only
  // operation. Other roles can still (re)build the order graph itself.
  if (parsed.data.recalculate_connections && c.role !== "admin" && c.role !== "driver") {
    return res
      .status(403)
      .json({ error: "Only admins and drivers can recalculate zone connections" });
  }

  try {
    const graph = await rebuildOrderGraph(c, orderId, parsed.data);
    res.json({
      message: parsed.data.recalculate_connections
        ? "Zone connections recalculated and order graph rebuilt"
        : "Order graph built",
      ...graph,
    });
  } catch (err) {
    fail(res, err);
  }
});
