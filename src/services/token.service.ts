import crypto from "crypto";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import { pool } from "../database";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "dev-access-secret-change-me";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret-change-me";
const RESET_SECRET = process.env.JWT_RESET_SECRET || "dev-reset-secret-change-me";

const ACCESS_TTL = process.env.JWT_ACCESS_TTL || "15m";
const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS) || 30;
const REFRESH_TTL = `${REFRESH_TTL_DAYS}d`;
const RESET_TTL = process.env.JWT_RESET_TTL || "1h";

if (process.env.NODE_ENV === "production") {
  if (ACCESS_SECRET.startsWith("dev-") || REFRESH_SECRET.startsWith("dev-")) {
    console.warn(
      "[auth] WARNING: JWT secrets are using development defaults in production. Set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET."
    );
  }
}

export interface AccessTokenPayload extends JwtPayload {
  sub: string;
  email: string;
  type: "access";
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string;
  jti: string;
  type: "refresh";
}

export interface ResetTokenPayload extends JwtPayload {
  sub: string;
  jti: string;
  type: "reset";
}

export function signAccessToken(userId: number, email: string): string {
  const payload: Omit<AccessTokenPayload, keyof JwtPayload> = { sub: String(userId), email, type: "access" };
  const opts: SignOptions = { expiresIn: ACCESS_TTL as SignOptions["expiresIn"] };
  return jwt.sign(payload, ACCESS_SECRET, opts);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
  if (decoded.type !== "access") throw new Error("Invalid token type");
  return decoded;
}

function signRefreshToken(userId: number, jti: string): string {
  const payload: Omit<RefreshTokenPayload, keyof JwtPayload> = { sub: String(userId), jti, type: "refresh" };
  const opts: SignOptions = { expiresIn: REFRESH_TTL as SignOptions["expiresIn"] };
  return jwt.sign(payload, REFRESH_SECRET, opts);
}

function verifyRefreshSignature(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, REFRESH_SECRET) as RefreshTokenPayload;
  if (decoded.type !== "refresh") throw new Error("Invalid token type");
  return decoded;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Mint a refresh token + persist its hash. Returns the raw token (only time
 * the plaintext value exists outside the client).
 */
export async function issueRefreshToken(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const jti = crypto.randomUUID();
  const token = signRefreshToken(userId, jti);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, sha256(token), expiresAt]
  );

  return { token, expiresAt };
}

/**
 * Validate a refresh token end-to-end: signature, expiration, DB presence,
 * and revocation state. Returns the resolved user id on success.
 */
export async function validateRefreshToken(token: string): Promise<number> {
  const payload = verifyRefreshSignature(token);
  const userId = Number(payload.sub);
  if (!Number.isInteger(userId)) throw new Error("Invalid refresh token");

  const result = await pool.query(
    `SELECT id, revoked_at, expires_at
     FROM refresh_tokens
     WHERE token_hash = $1 AND user_id = $2`,
    [sha256(token), userId]
  );

  const row = result.rows[0];
  if (!row) throw new Error("Refresh token not recognised");
  if (row.revoked_at) throw new Error("Refresh token revoked");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error("Refresh token expired");

  return userId;
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256(token)]
  );
}

export async function revokeAllUserRefreshTokens(userId: number): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

/**
 * Issue a single-use password reset token. The JWT carries claims so we can
 * verify intent without a DB hit; the DB row enforces single-use semantics.
 */
export async function issuePasswordResetToken(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const jti = crypto.randomUUID();
  const payload: Omit<ResetTokenPayload, keyof JwtPayload> = { sub: String(userId), jti, type: "reset" };
  const opts: SignOptions = { expiresIn: RESET_TTL as SignOptions["expiresIn"] };
  const token = jwt.sign(payload, RESET_SECRET, opts);
  const decoded = jwt.decode(token) as JwtPayload;
  const expiresAt = new Date((decoded?.exp ?? Math.floor(Date.now() / 1000)) * 1000);

  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, sha256(token), expiresAt]
  );

  return { token, expiresAt };
}

export async function consumePasswordResetToken(token: string): Promise<number> {
  let payload: ResetTokenPayload;
  try {
    payload = jwt.verify(token, RESET_SECRET) as ResetTokenPayload;
  } catch {
    throw new Error("Reset token is invalid or expired");
  }
  if (payload.type !== "reset") throw new Error("Invalid token type");

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId)) throw new Error("Invalid reset token");

  const result = await pool.query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE token_hash = $1
       AND user_id = $2
       AND used_at IS NULL
       AND expires_at > NOW()
     RETURNING id`,
    [sha256(token), userId]
  );

  if (result.rowCount === 0) {
    throw new Error("Reset token is invalid or already used");
  }

  return userId;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number; // seconds until access token expiry
}

export async function issueTokenPair(userId: number, email: string): Promise<TokenPair> {
  const accessToken = signAccessToken(userId, email);
  const { token: refreshToken } = await issueRefreshToken(userId);

  const decoded = jwt.decode(accessToken) as JwtPayload;
  const expiresIn = decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 900;

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: Math.max(0, expiresIn),
  };
}
