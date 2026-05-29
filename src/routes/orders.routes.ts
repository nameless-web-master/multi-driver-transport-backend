import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { latitudeSchema, longitudeSchema } from "../schemas/h3.schema";
import {
  createOrderSchema,
  updateOrderStatusSchema,
} from "../schemas/order.schema";
import {
  OrderError,
  createOrder,
  getOrderById,
  listOrders,
  updateOrderStatus,
} from "../services/order.service";
import {
  DEFAULT_PREVIEW_MAX_DEPTH,
  previewOrderZoneConnectionsByCoordinates,
} from "../services/orderZoneConnection.service";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest) {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

const draftPreviewSchema = z.object({
  source_lat: latitudeSchema,
  source_lng: longitudeSchema,
  destination_lat: latitudeSchema,
  destination_lng: longitudeSchema,
  source_name: z.string().trim().max(200).optional(),
  source_address: z.string().trim().max(300).optional(),
  destination_name: z.string().trim().max(200).optional(),
  destination_address: z.string().trim().max(300).optional(),
  max_depth: z.coerce.number().int().positive().max(20).optional(),
});

function handle(res: Response, err: unknown) {
  if (err instanceof OrderError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Order operation failed";
  console.error("[orders]", err);
  res.status(500).json({ error: message });
}

/**
 * POST /api/orders/zone-connection-preview
 *
 * Milestone 2 — let the sender preview the zone-connection graph between a
 * draft pickup coordinate and the receiver's drop-off coordinate before
 * actually submitting the order. This is a *preview only*: no order row is
 * created, no driver is assigned, no route is generated.
 *
 * Registered before `/:id` so "zone-connection-preview" isn't parsed as an
 * order id.
 */
ordersRouter.post(
  "/zone-connection-preview",
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = draftPreviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const c = ctx(req);
    if (c.role !== "sender" && c.role !== "admin") {
      return res
        .status(403)
        .json({ error: "Only senders and admins can preview a draft order" });
    }
    try {
      const preview = await previewOrderZoneConnectionsByCoordinates({
        ...parsed.data,
        max_depth: parsed.data.max_depth ?? DEFAULT_PREVIEW_MAX_DEPTH,
      });
      res.json(preview);
    } catch (err) {
      handle(res, err);
    }
  }
);

ordersRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orders = await listOrders(ctx(req));
    res.json(orders);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const order = await getOrderById(id, ctx(req));
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const order = await createOrder(ctx(req), parsed.data);
    res.status(201).json(order);
  } catch (err) {
    handle(res, err);
  }
});

ordersRouter.patch("/:id/status", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const parsed = updateOrderStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const order = await updateOrderStatus(id, ctx(req), parsed.data);
    res.json(order);
  } catch (err) {
    handle(res, err);
  }
});
