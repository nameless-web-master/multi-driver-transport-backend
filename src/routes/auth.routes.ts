import { Request, Response, Router } from "express";
import { AuthenticatedRequest, requireAuth } from "../dependencies/auth.middleware";
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from "../schemas/auth.schema";
import {
  AuthError,
  forgotPassword,
  loginUser,
  logoutUser,
  refreshSession,
  registerUser,
  resetPassword,
} from "../services/auth.service";

export const authRouter = Router();

function handleAuthError(res: Response, err: unknown): void {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Authentication failed";
  console.error("[auth]", err);
  res.status(500).json({ error: message });
}

authRouter.post("/register", async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const { user, tokens } = await registerUser(parsed.data);
    res.status(201).json({ user, ...tokens });
  } catch (err) {
    handleAuthError(res, err);
  }
});

authRouter.post("/login", async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const { user, tokens } = await loginUser(parsed.data);
    res.json({ user, ...tokens });
  } catch (err) {
    handleAuthError(res, err);
  }
});

authRouter.post("/refresh", async (req: Request, res: Response) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const tokens = await refreshSession(parsed.data.refresh_token);
    res.json(tokens);
  } catch (err) {
    handleAuthError(res, err);
  }
});

authRouter.post("/logout", async (req: AuthenticatedRequest, res: Response) => {
  const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : undefined;
  try {
    await logoutUser(refreshToken, undefined);
    res.status(204).send();
  } catch (err) {
    handleAuthError(res, err);
  }
});

authRouter.post("/forgot-password", async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const result = await forgotPassword(parsed.data);
    res.json(result);
  } catch (err) {
    handleAuthError(res, err);
  }
});

authRouter.post("/reset-password", async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    await resetPassword(parsed.data);
    res.json({ message: "Password updated. Please log in again." });
  } catch (err) {
    handleAuthError(res, err);
  }
});

authRouter.get("/me", requireAuth, (req: AuthenticatedRequest, res: Response) => {
  res.json({ user: req.user });
});
