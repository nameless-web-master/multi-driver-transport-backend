import { NextFunction, Request, Response } from "express";
import { PublicUser, toPublicUser } from "../models/user.model";
import type { UserRole } from "../models/userRole.model";
import { getUserById } from "../services/auth.service";
import { verifyAccessToken } from "../services/token.service";

export interface AuthenticatedRequest extends Request {
  user?: PublicUser;
  userId?: number;
  userRole?: UserRole;
}

/**
 * Express middleware that resolves the current user from a Bearer access token.
 * On success, attaches `req.user` / `req.userId`. On failure, responds 401.
 *
 * Designed to mirror a FastAPI `Depends(get_current_user)` style dependency
 * so route handlers remain thin.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.header("authorization") || req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "Missing access token" });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    const userId = Number(payload.sub);
    const user = await getUserById(userId);
    if (!user || !user.is_active) {
      res.status(401).json({ error: "Account not available" });
      return;
    }
    req.user = toPublicUser(user);
    req.userId = user.id;
    req.userRole = user.role;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.userRole !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
