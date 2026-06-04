import { Pool, PoolConfig } from "pg";
import dotenv from "dotenv";
import { CURRENCIES } from "./models/currency.model";

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

  /**
   * Performance/stability tuning notes:
   * - keepAlive: sends TCP keep-alive probes so NAT / managed providers
   *   (Render free tier, Heroku, etc.) don't silently drop idle sockets.
   * - keepAliveInitialDelayMillis: start probing well before the typical
   *   ~5-minute idle kill window on Render.
   * - idleTimeoutMillis: recycle pool clients ourselves *before* the
   *   server kills them, so we don't hand out half-dead sockets.
   * - connectionTimeoutMillis: bound how long a single connect attempt
   *   can hang on a slow / unreachable remote DB.
   * - statement_timeout: prevent a single runaway query from holding a
   *   client forever.
   */
  const shared: Partial<PoolConfig> = {
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS) || 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 15_000,
  };

  if (process.env.DATABASE_URL) {
    return { ...shared, connectionString: process.env.DATABASE_URL, ssl };
  }
  return {
    ...shared,
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "multi_driver_h3",
    ssl,
  };
}

export const pool = new Pool(buildPoolConfig());

/**
 * pg emits a pool-level `error` event when an *idle* client throws (typical
 * symptom on Render free tier: `Connection terminated unexpectedly`). If we
 * don't attach a listener the process can crash. Logging it lets the pool
 * silently evict the dead client and create a fresh one on the next acquire.
 */
pool.on("error", (err) => {
  console.error("[pg] idle client error (dropping client):", err.message);
});

/**
 * Idempotent schema bootstrap.
 *
 * Supports three primary roles: driver, sender, receiver (plus admin).
 * Drivers create zones (H3 cells / geofences) with per-zone cost and
 * settings. Senders create orders that target a receiver and travel
 * through driver zones.
 */
export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        full_name       TEXT        NOT NULL,
        company_name    TEXT        NOT NULL DEFAULT '',
        email           TEXT        NOT NULL UNIQUE,
        hashed_password TEXT        NOT NULL,
        role            TEXT        NOT NULL DEFAULT 'sender',
        phone           TEXT        NOT NULL DEFAULT '',
        address         TEXT        NOT NULL DEFAULT '',
        lat             DOUBLE PRECISION,
        lng             DOUBLE PRECISION,
        trustworthiness INTEGER     NOT NULL DEFAULT 0,
        is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Backfill columns on existing installs.
    await client.query(`ALTER TABLE users ALTER COLUMN company_name DROP NOT NULL;`).catch(() => undefined);
    await client.query(`ALTER TABLE users ALTER COLUMN company_name SET DEFAULT '';`);
    await client.query(`UPDATE users SET company_name = '' WHERE company_name IS NULL;`);
    await client.query(`ALTER TABLE users ALTER COLUMN company_name SET NOT NULL;`);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trustworthiness INTEGER NOT NULL DEFAULT 0;`);

    // Refresh the role check constraint to cover the new roles.
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
    await client.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_role_check
        CHECK (role IN ('admin', 'driver', 'sender', 'receiver', 'user'));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_lower
      ON users (LOWER(email));
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_zones (
        id                       SERIAL PRIMARY KEY,
        owner_user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
        driver_name              TEXT        NOT NULL,
        zone_name                TEXT        NOT NULL,
        resolution               INTEGER     NOT NULL CHECK (resolution BETWEEN 0 AND 15),
        h3_cells                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
        transport_modes          TEXT[]      NOT NULL DEFAULT '{}',
        transport_mode           TEXT,
        boundary                 JSONB,
        rate_cost                NUMERIC(12, 2) NOT NULL DEFAULT 0,
        currency                 TEXT        NOT NULL DEFAULT 'USD',
        available                BOOLEAN     NOT NULL DEFAULT TRUE,
        trust_payment_forwarder  BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS transport_modes TEXT[] NOT NULL DEFAULT '{}';`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS transport_mode TEXT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS boundary JSONB;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS rate_cost NUMERIC(12, 2) NOT NULL DEFAULT 0;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT TRUE;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS trust_payment_forwarder BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Persist the zone creation method explicitly (previously inferred from
    // the presence of a boundary). "geofence" when a polygon boundary was
    // drawn, otherwise "h3". Backfilled from `boundary` for existing rows.
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS zone_type TEXT NOT NULL DEFAULT 'h3';`);
    await client.query(
      `UPDATE driver_zones SET zone_type = CASE WHEN boundary IS NOT NULL THEN 'geofence' ELSE 'h3' END
       WHERE zone_type IS NULL OR zone_type = '';`
    );
    await client.query(`ALTER TABLE driver_zones DROP CONSTRAINT IF EXISTS driver_zones_zone_type_check;`);
    await client.query(
      `ALTER TABLE driver_zones ADD CONSTRAINT driver_zones_zone_type_check CHECK (zone_type IN ('h3', 'geofence'));`
    );
    // Drop and rebuild the currency CHECK each boot so adding a code to
    // `CURRENCIES` automatically widens the allowed set without a manual
    // migration. The IN list is derived from the same constant the API uses.
    await client.query(`ALTER TABLE driver_zones DROP CONSTRAINT IF EXISTS driver_zones_currency_check;`);
    const currencyList = CURRENCIES.map((c) => `'${c}'`).join(", ");
    await client.query(
      `ALTER TABLE driver_zones
         ADD CONSTRAINT driver_zones_currency_check CHECK (currency IN (${currencyList}));`
    );
    // Backfill transport_mode from the existing array, defaulting to 'land'.
    await client.query(`UPDATE driver_zones SET transport_mode = COALESCE(transport_mode, transport_modes[1], 'land') WHERE transport_mode IS NULL OR transport_mode = '';`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_zones_owner_user_id ON driver_zones (owner_user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_zones_h3_cells ON driver_zones USING GIN (h3_cells);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_zones_resolution ON driver_zones (resolution);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_zones_available ON driver_zones (available);`);

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

    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens (user_id);`);

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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens (user_id);`);

    // Followers (sender / receiver follow drivers; each follow bumps trustworthiness).
    await client.query(`
      CREATE TABLE IF NOT EXISTS follows (
        follower_user_id INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        driver_user_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (follower_user_id, driver_user_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_follows_driver_user_id ON follows (driver_user_id);`);

    // Orders (sender -> receiver, optionally fulfilled by a driver).
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id                  SERIAL PRIMARY KEY,
        sender_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        driver_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sender_address      TEXT    NOT NULL DEFAULT '',
        sender_lat          DOUBLE PRECISION,
        sender_lng          DOUBLE PRECISION,
        destination_address TEXT    NOT NULL DEFAULT '',
        destination_lat     DOUBLE PRECISION,
        destination_lng     DOUBLE PRECISION,
        receiver_phone      TEXT    NOT NULL DEFAULT '',
        notes               TEXT    NOT NULL DEFAULT '',
        status              TEXT    NOT NULL DEFAULT 'submitted',
        submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivering_at       TIMESTAMPTZ,
        received_at         TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT orders_status_check CHECK (status IN ('submitted', 'delivering', 'received'))
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_sender_user_id ON orders (sender_user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_receiver_user_id ON orders (receiver_user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_driver_user_id ON orders (driver_user_id);`);

    // ----------------------------------------------------------------------
    // Milestone 1 (updated scope): orders carry the H3 indexes of their
    // pickup and delivery coordinates, plus the basic package/shipping
    // metadata the signed-off order form collects. All additive so existing
    // installs keep working — older rows simply get NULL until recreated
    // (we backfill H3 from existing coordinates a few lines down).
    // ----------------------------------------------------------------------
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_h3 TEXT;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_h3 TEXT;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS h3_resolution INTEGER;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_name TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_contact TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_method TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_description TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(12, 3);`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dimensions TEXT NOT NULL DEFAULT '';`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_pickup_h3 ON orders (pickup_h3);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_delivery_h3 ON orders (delivery_h3);`);

    // ----------------------------------------------------------------------
    // Milestone 2: zone overlap / adjacency graph.
    //
    // Each row represents one undirected connection between two driver zones
    // (zone_a_id < zone_b_id by convention to prevent A-B/B-A duplicates).
    // `connection_type` is "overlap" when the zones share H3 cells,
    // "adjacent" when they don't share cells but at least one cell pair
    // are direct neighbours. transfer_cells holds the shared H3 cells for
    // overlaps (or representative cells for adjacency).
    // adjacent_cell_pairs is the full list of touching boundary pairs.
    // ----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS zone_connections (
        id                   SERIAL PRIMARY KEY,
        zone_a_id            INTEGER NOT NULL REFERENCES driver_zones(id) ON DELETE CASCADE,
        zone_b_id            INTEGER NOT NULL REFERENCES driver_zones(id) ON DELETE CASCADE,
        transport_a_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        transport_b_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_type      TEXT    NOT NULL,
        transfer_cells       JSONB   NOT NULL DEFAULT '[]'::jsonb,
        adjacent_cell_pairs  JSONB,
        transport_method_a   TEXT,
        transport_method_b   TEXT,
        is_active            BOOLEAN NOT NULL DEFAULT TRUE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT zone_connections_no_self CHECK (zone_a_id <> zone_b_id),
        CONSTRAINT zone_connections_type_check CHECK (connection_type IN ('overlap', 'adjacent')),
        CONSTRAINT zone_connections_unique UNIQUE (zone_a_id, zone_b_id)
      );
    `);
    // Milestone 2 (updated scope): one recommended transfer cell per
    // connection. Chosen from `transfer_cells` (overlap) or the adjacent
    // pairs (adjacency) using the midpoint-of-centroids rule in
    // zoneConnection.service.ts. Additive + nullable for existing rows;
    // the next recalculation fills it in.
    await client.query(`ALTER TABLE zone_connections ADD COLUMN IF NOT EXISTS recommended_transfer_cell TEXT;`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_zone_a ON zone_connections (zone_a_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_zone_b ON zone_connections (zone_b_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_transport_a ON zone_connections (transport_a_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_transport_b ON zone_connections (transport_b_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_is_active ON zone_connections (is_active);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_type ON zone_connections (connection_type);`);

    console.log("[db] schema ready");
  } finally {
    client.release();
  }
}
