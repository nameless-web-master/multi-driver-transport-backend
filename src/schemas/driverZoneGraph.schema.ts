import { z } from "zod";

/**
 * Milestone 3 — Driver-Zone Graph request/response schemas.
 *
 * The graph itself is constructed in `services/driverZoneGraph.service.ts`;
 * the types in `models/driverZoneGraph.model.ts` describe its shape. The
 * schemas here cover only the small query/payload surface needed by the
 * Express routes.
 */

export const componentIdSchema = z.string().trim().min(1).max(64);

export const zoneIdParamSchema = z
  .string()
  .regex(/^\d+$/u, "Zone id must be a positive integer")
  .transform((v) => Number(v))
  .pipe(z.number().int().positive());

export const rebuildOptionsSchema = z
  .object({
    /**
     * When true, the rebuild endpoint first re-runs Milestone 2's full
     * zone-connection recalculation and *then* rebuilds the graph. Useful
     * for the dashboard's "Recalculate Connections & Rebuild Graph" button.
     */
    recalculate_connections: z.boolean().optional().default(false),
  })
  .partial()
  .default({});

export type RebuildOptions = z.infer<typeof rebuildOptionsSchema>;
