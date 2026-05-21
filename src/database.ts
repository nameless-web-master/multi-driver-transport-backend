import { Pool, PoolConfig } from "pg";
import dotenv from "dotenv";

dotenv.config();

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Remote providers (Render, Neon, Supabase, etc.) require SSL. */
function resolveSsl(): PoolConfig["ssl"] | undefined {
  const flag = (process.env.PGSSLMODE || process.env.DATABASE_SSL || "").toLowerCase();
  if (flag === "disable" || flag === "false") return undefined;
  if (flag === "require" || flag === "true") {
    return { rejectUnauthorized: false };
  }

  const host = process.env.PGHOST || "";
  const url = process.env.DATABASE_URL || "";
  const isLocalHost = LOCAL_HOSTS.has(host);
  const isRemoteUrl = /\.render\.com|neon\.tech|supabase\.co|amazonaws\.com/i.test(url);

  if ((!isLocalHost && host) || isRemoteUrl) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function buildPoolConfig(): PoolConfig {
  const ssl = resolveSsl();
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ssl };
  }
  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "multi_driver_h3",
    ssl,
  };
}

export const pool = new Pool(buildPoolConfig());

pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});

/**
 * Idempotent schema bootstrap.
 *
 * h3_cells is stored as JSONB so that future milestones (overlap detection,
 * adjacency graph, multi-driver path generation) can query/index individual
 * H3 indexes efficiently with GIN indexes.
 */
export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_zones (
        id           SERIAL PRIMARY KEY,
        driver_name  TEXT      NOT NULL,
        zone_name    TEXT      NOT NULL,
        resolution   INTEGER   NOT NULL CHECK (resolution BETWEEN 0 AND 15),
        h3_cells     JSONB     NOT NULL DEFAULT '[]'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // GIN index enables fast overlap / containment queries in Milestone 2+.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_driver_zones_h3_cells
      ON driver_zones USING GIN (h3_cells);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_driver_zones_resolution
      ON driver_zones (resolution);
    `);

    /**
     * Auth tables.
     *
     * users: canonical account record. `hashed_password` stores a bcrypt hash;
     *   plaintext is never persisted. `is_active` lets future milestones disable
     *   accounts without deletion.
     * refresh_tokens: opaque refresh-token rotation store. Tokens are SHA-256
     *   hashed before storage so a DB compromise cannot mint sessions.
     * password_reset_tokens: short-lived bcrypt-hashed reset tokens. Structure
     *   is ready for email delivery in a later milestone.
     */
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        full_name       TEXT        NOT NULL,
        company_name    TEXT        NOT NULL,
        email           TEXT        NOT NULL UNIQUE,
        hashed_password TEXT        NOT NULL,
        is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_lower
      ON users (LOWER(email));
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT        NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        revoked_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
      ON refresh_tokens (user_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT        NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
      ON password_reset_tokens (user_id);
    `);

    console.log("[db] schema ready");
  } finally {
    client.release();
  }
}
