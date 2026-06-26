import { pool } from "../database";
import type {
  NotificationListResponse,
  NotificationType,
  UserNotificationResponse,
} from "../models/notification.model";

export async function getOrderParticipantUserIds(orderId: number): Promise<number[]> {
  const result = await pool.query(
    `SELECT DISTINCT uid FROM (
       SELECT o.sender_user_id AS uid FROM orders o WHERE o.id = $1
       UNION
       SELECT o.receiver_user_id FROM orders o WHERE o.id = $1
       UNION
       SELECT sc.transporter_id
       FROM route_segment_costs sc
       JOIN order_routes r ON r.id = sc.route_id
       WHERE r.order_id = $1
     ) participants
     WHERE uid IS NOT NULL`,
    [orderId]
  );
  return result.rows.map((r) => Number(r.uid));
}

export async function getRouteTransporterIds(routeId: number): Promise<number[]> {
  const result = await pool.query(
    `SELECT DISTINCT transporter_id FROM route_segment_costs WHERE route_id = $1`,
    [routeId]
  );
  return result.rows.map((r) => Number(r.transporter_id));
}

export async function createUserNotification(input: {
  user_id: number;
  order_id?: number | null;
  type: NotificationType;
  title: string;
  body: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO user_notifications (user_id, order_id, type, title, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.user_id,
      input.order_id ?? null,
      input.type,
      input.title,
      input.body,
    ]
  );
}

export async function notifyUsers(input: {
  user_ids: number[];
  order_id?: number | null;
  type: NotificationType;
  title: string;
  body: string;
  exclude_user_id?: number | null;
}): Promise<void> {
  const targets = [
    ...new Set(
      input.user_ids.filter(
        (id) => Number.isFinite(id) && id > 0 && id !== input.exclude_user_id
      )
    ),
  ];
  if (targets.length === 0) return;

  for (const userId of targets) {
    await createUserNotification({
      user_id: userId,
      order_id: input.order_id ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
    });
  }
}

export async function notifyOrderParticipants(input: {
  order_id: number;
  type: NotificationType;
  title: string;
  body: string;
  exclude_user_id?: number | null;
  extra_user_ids?: number[];
}): Promise<void> {
  const participantIds = await getOrderParticipantUserIds(input.order_id);
  const allIds = [...participantIds, ...(input.extra_user_ids ?? [])];
  await notifyUsers({
    user_ids: allIds,
    order_id: input.order_id,
    type: input.type,
    title: input.title,
    body: input.body,
    exclude_user_id: input.exclude_user_id,
  });
}

function rowToResponse(row: Record<string, unknown>): UserNotificationResponse {
  return {
    id: Number(row.id),
    order_id: row.order_id != null ? Number(row.order_id) : null,
    type: String(row.type) as NotificationType,
    title: String(row.title),
    body: String(row.body),
    read_at: row.read_at ? new Date(String(row.read_at)).toISOString() : null,
    created_at: new Date(String(row.created_at)).toISOString(),
  };
}

export async function listUserNotifications(
  userId: number,
  limit = 50
): Promise<NotificationListResponse> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const [itemsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM user_notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, safeLimit]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM user_notifications
       WHERE user_id = $1 AND read_at IS NULL`,
      [userId]
    ),
  ]);

  return {
    items: itemsResult.rows.map(rowToResponse),
    unread_count: Number(countResult.rows[0]?.c ?? 0),
  };
}

export async function markNotificationRead(
  notificationId: number,
  userId: number
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE user_notifications
     SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2`,
    [notificationId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markAllNotificationsRead(userId: number): Promise<number> {
  const result = await pool.query(
    `UPDATE user_notifications
     SET read_at = NOW()
     WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return result.rowCount ?? 0;
}
