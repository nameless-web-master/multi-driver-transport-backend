import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import {
  createRateTableSchema,
  updateRateTableSchema,
} from "../schemas/rateTable.schema";
import {
  RateTableError,
  createRateTable,
  deactivateRateTable,
  getRateTableById,
  getRateTables,
  updateRateTable,
} from "../services/rateTable.service";

export const rateTablesRouter = Router();

rateTablesRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest) {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

function handle(res: Response, err: unknown) {
  if (err instanceof RateTableError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Rate table operation failed";
  console.error("[rate-tables]", err);
  res.status(500).json({ error: message });
}

rateTablesRouter.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = createRateTableSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const table = await createRateTable(ctx(req), parsed.data);
    res.status(201).json(table);
  } catch (err) {
    handle(res, err);
  }
});

rateTablesRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const transporterParam = req.query.transporter_id;
    const methodParam = req.query.transport_method;
    const activeParam = req.query.is_active;
    const transporterId =
      typeof transporterParam === "string" && transporterParam
        ? Number(transporterParam)
        : undefined;
    const isActive =
      activeParam === "true" ? true : activeParam === "false" ? false : undefined;

    const tables = await getRateTables(ctx(req), {
      transporter_id: Number.isFinite(transporterId) ? transporterId : undefined,
      transport_method:
        typeof methodParam === "string" && methodParam ? methodParam : undefined,
      is_active: isActive,
    });
    res.json(tables);
  } catch (err) {
    handle(res, err);
  }
});

rateTablesRouter.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid rate table id" });
  }
  try {
    const table = await getRateTableById(ctx(req), id);
    if (!table) return res.status(404).json({ error: "Rate table not found" });
    res.json(table);
  } catch (err) {
    handle(res, err);
  }
});

rateTablesRouter.put("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid rate table id" });
  }
  const parsed = updateRateTableSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const table = await updateRateTable(ctx(req), id, parsed.data);
    res.json(table);
  } catch (err) {
    handle(res, err);
  }
});

rateTablesRouter.delete("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid rate table id" });
  }
  try {
    await deactivateRateTable(ctx(req), id);
    res.status(204).send();
  } catch (err) {
    handle(res, err);
  }
});
