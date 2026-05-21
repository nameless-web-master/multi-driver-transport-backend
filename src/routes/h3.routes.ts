import { Router, Request, Response } from "express";
import { requireAuth } from "../dependencies/auth.middleware";
import { convertRequestSchema, ConvertResponse } from "../schemas/h3.schema";
import { cellCenter, H3Resolution, pointToCell } from "../services/h3_service";

export const h3Router = Router();

h3Router.use(requireAuth);

h3Router.post("/convert", (req: Request, res: Response) => {
  const parsed = convertRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, resolution } = parsed.data;

  try {
    const h3Resolution = resolution as H3Resolution;
    const pickup_h3 = pointToCell(pickup_lat, pickup_lng, h3Resolution);
    const dropoff_h3 = pointToCell(dropoff_lat, dropoff_lng, h3Resolution);

    const body: ConvertResponse = {
      pickup_h3,
      dropoff_h3,
      resolution,
      cell_type: "Hexagon",
      pickup_center: cellCenter(pickup_h3),
      dropoff_center: cellCenter(dropoff_h3),
    };
    return res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "H3 conversion failed";
    return res.status(400).json({ error: message });
  }
});
