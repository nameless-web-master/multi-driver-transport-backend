import { Router, Response } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import { listDrivers, listReceivers } from "../services/users.service";
import { FollowError, followDriver, unfollowDriver } from "../services/follow.service";

export const usersRouter = Router();

usersRouter.use(requireAuth);

function ctx(req: AuthenticatedRequest) {
  return { userId: req.userId!, role: req.userRole ?? "sender" };
}

usersRouter.get("/receivers", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const receivers = await listReceivers();
    res.json(receivers);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list receivers";
    res.status(500).json({ error: message });
  }
});

usersRouter.get("/drivers", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const drivers = await listDrivers(req.userId!);
    res.json(drivers);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list drivers";
    res.status(500).json({ error: message });
  }
});

function handleFollowError(res: Response, err: unknown) {
  if (err instanceof FollowError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Follow operation failed";
  console.error("[follows]", err);
  res.status(500).json({ error: message });
}

usersRouter.post("/drivers/:id/follow", async (req: AuthenticatedRequest, res: Response) => {
  const driverId = Number(req.params.id);
  if (!Number.isInteger(driverId) || driverId < 1) {
    return res.status(400).json({ error: "Invalid driver id" });
  }
  try {
    const result = await followDriver(ctx(req), driverId);
    res.json(result);
  } catch (err) {
    handleFollowError(res, err);
  }
});

usersRouter.delete("/drivers/:id/follow", async (req: AuthenticatedRequest, res: Response) => {
  const driverId = Number(req.params.id);
  if (!Number.isInteger(driverId) || driverId < 1) {
    return res.status(400).json({ error: "Invalid driver id" });
  }
  try {
    const result = await unfollowDriver(ctx(req), driverId);
    res.json(result);
  } catch (err) {
    handleFollowError(res, err);
  }
});
