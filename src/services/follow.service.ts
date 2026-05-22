import { pool } from "../database";
import type { UserRole } from "../models/userRole.model";

export class FollowError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface FollowContext {
  userId: number;
  role: UserRole;
}

async function assertDriver(driverUserId: number): Promise<void> {
  const result = await pool.query(`SELECT role FROM users WHERE id = $1`, [driverUserId]);
  if (result.rowCount === 0) throw new FollowError("Driver not found", 404);
  if (result.rows[0].role !== "driver") {
    throw new FollowError("User is not a driver", 400);
  }
}

export async function followDriver(ctx: FollowContext, driverUserId: number): Promise<{ followed: boolean; trustworthiness: number }> {
  if (ctx.userId === driverUserId) throw new FollowError("Cannot follow yourself", 400);
  if (ctx.role !== "sender" && ctx.role !== "receiver") {
    throw new FollowError("Only senders or receivers can follow drivers", 403);
  }
  await assertDriver(driverUserId);

  const inserted = await pool.query(
    `INSERT INTO follows (follower_user_id, driver_user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING follower_user_id`,
    [ctx.userId, driverUserId]
  );

  if ((inserted.rowCount ?? 0) > 0) {
    await pool.query(
      `UPDATE users SET trustworthiness = trustworthiness + 1, updated_at = NOW() WHERE id = $1`,
      [driverUserId]
    );
  }

  const trust = await pool.query(`SELECT trustworthiness FROM users WHERE id = $1`, [driverUserId]);
  return {
    followed: true,
    trustworthiness: Number(trust.rows[0]?.trustworthiness ?? 0),
  };
}

export async function unfollowDriver(ctx: FollowContext, driverUserId: number): Promise<{ followed: boolean; trustworthiness: number }> {
  const deleted = await pool.query(
    `DELETE FROM follows WHERE follower_user_id = $1 AND driver_user_id = $2 RETURNING follower_user_id`,
    [ctx.userId, driverUserId]
  );

  if ((deleted.rowCount ?? 0) > 0) {
    await pool.query(
      `UPDATE users SET trustworthiness = GREATEST(0, trustworthiness - 1), updated_at = NOW() WHERE id = $1`,
      [driverUserId]
    );
  }

  const trust = await pool.query(`SELECT trustworthiness FROM users WHERE id = $1`, [driverUserId]);
  return {
    followed: false,
    trustworthiness: Number(trust.rows[0]?.trustworthiness ?? 0),
  };
}

export async function isFollowing(followerId: number, driverId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM follows WHERE follower_user_id = $1 AND driver_user_id = $2`,
    [followerId, driverId]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listFollowedDriverIds(followerId: number): Promise<number[]> {
  const r = await pool.query(
    `SELECT driver_user_id FROM follows WHERE follower_user_id = $1`,
    [followerId]
  );
  return r.rows.map((row) => Number(row.driver_user_id));
}
