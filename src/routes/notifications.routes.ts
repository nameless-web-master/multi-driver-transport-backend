import { Response, Router } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import {
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/notification.service";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

  try {
    const data = await listUserNotifications(userId, limit);
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load notifications";
    console.error("[notifications]", err);
    res.status(500).json({ error: message });
  }
});

notificationsRouter.post("/read-all", async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const updated = await markAllNotificationsRead(userId);
    res.json({ updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to mark notifications read";
    console.error("[notifications]", err);
    res.status(500).json({ error: message });
  }
});

notificationsRouter.post("/:id/read", async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid notification id" });
  }

  try {
    const ok = await markNotificationRead(id, userId);
    if (!ok) return res.status(404).json({ error: "Notification not found" });
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to mark notification read";
    console.error("[notifications]", err);
    res.status(500).json({ error: message });
  }
});
