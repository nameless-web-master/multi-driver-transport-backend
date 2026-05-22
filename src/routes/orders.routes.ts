import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
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

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest) {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

function handle(res: Response, err: unknown) {
  if (err instanceof OrderError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Order operation failed";
  console.error("[orders]", err);
  res.status(500).json({ error: message });
}

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
