import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";

export const rateTablesRouter = Router();

rateTablesRouter.use(requireAuth);

const DEPRECATION = {
  error:
    "Transporter rate tables are deprecated. Configure per-zone pricing (base fee, cost/km, cost/hour) on driver zones instead.",
  migration: "driver-zones",
  docs: "Milestone 5 pricing uses driver zone rates and the segment cost formula.",
};

rateTablesRouter.use((_req: AuthenticatedRequest, res: Response) => {
  res.status(410).json(DEPRECATION);
});
