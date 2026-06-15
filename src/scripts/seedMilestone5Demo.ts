/**
 * Milestone 5 demo seed — sets per-zone pricing for existing transporters.
 *
 * Pricing now lives on each driver zone (not a separate rate table), so this
 * script applies the test-scenario rates to every zone owned by the first
 * three transporters.
 *
 * Usage (from backend folder, with DB running):
 *   npx ts-node src/scripts/seedMilestone5Demo.ts
 *
 * Prerequisites: transporters A, B, C with zones that form connected routes
 * for a test order (Box, 5 kg, 40×30×20).
 */
import dotenv from "dotenv";
import { pool, ensureSchema } from "../database";

dotenv.config();

interface ZoneRates {
  base_fee: number;
  cost_per_h3_cell: number | null;
  cost_per_km: number | null;
  cost_per_kg: number | null;
  cost_per_volume_unit: number | null;
}

async function seedZoneRates(transporterId: number, rates: ZoneRates): Promise<void> {
  const result = await pool.query(
    `UPDATE driver_zones
     SET base_fee = $2, cost_per_h3_cell = $3, cost_per_km = $4,
         cost_per_kg = $5, cost_per_volume_unit = $6, updated_at = NOW()
     WHERE owner_user_id = $1`,
    [
      transporterId,
      rates.base_fee,
      rates.cost_per_h3_cell,
      rates.cost_per_km,
      rates.cost_per_kg,
      rates.cost_per_volume_unit,
    ]
  );
  console.log(
    `  ✓ Priced ${result.rowCount ?? 0} zone(s) for transporter #${transporterId}`
  );
}

async function main() {
  await ensureSchema();

  const drivers = await pool.query(
    `SELECT id, full_name FROM users WHERE role = 'driver' ORDER BY id LIMIT 10`
  );

  if (drivers.rowCount === 0) {
    console.log("No drivers found. Register transporters first.");
    process.exit(0);
  }

  console.log("Found drivers:");
  for (const d of drivers.rows) {
    console.log(`  #${d.id} — ${d.full_name}`);
  }

  // Map first three drivers to A, B, C for the test scenario
  const [a, b, c] = drivers.rows;

  if (a) {
    await seedZoneRates(Number(a.id), {
      base_fee: 20,
      cost_per_h3_cell: 2,
      cost_per_km: null,
      cost_per_kg: 1,
      cost_per_volume_unit: null,
    });
  }
  if (b) {
    await seedZoneRates(Number(b.id), {
      base_fee: 15,
      cost_per_h3_cell: 3,
      cost_per_km: null,
      cost_per_kg: 1.5,
      cost_per_volume_unit: null,
    });
  }
  if (c) {
    await seedZoneRates(Number(c.id), {
      base_fee: 80,
      cost_per_h3_cell: null,
      cost_per_km: null,
      cost_per_kg: 5,
      cost_per_volume_unit: 0.0001,
    });
  }

  console.log("\nDemo zone pricing seeded.");
  console.log("Create an order with: Box, 5 kg, 40×30×20");
  console.log("Then open the order and use Recalculate Costs to compare routes.");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
