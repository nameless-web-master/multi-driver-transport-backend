import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { listTransporterConfirmations } from "../services/route_confirmation.service";
import { RouteConfirmationError } from "../services/route_confirmation.service";
import { getTransporterOrders, OrderViewError } from "../services/orderView.service";

export const transporterRouter = Router();

transporterRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest) {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

function handle(res: Response, err: unknown) {
  if (err instanceof RouteConfirmationError || err instanceof OrderViewError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Transporter operation failed";
  console.error("[transporter]", err);
  res.status(500).json({ error: message });
}

transporterRouter.get("/orders", async (req: AuthenticatedRequest, res: Response) => {
  const c = ctx(req);
  if (c.role !== "driver" && c.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const orders = await getTransporterOrders(c);
    res.json(orders);
  } catch (err) {
    handle(res, err);
  }
});

transporterRouter.get("/confirmations", async (req: AuthenticatedRequest, res: Response) => {
  const c = ctx(req);
  if (c.role !== "driver" && c.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const items = await listTransporterConfirmations(c);
    res.json(items);
  } catch (err) {
    handle(res, err);
  }
});
