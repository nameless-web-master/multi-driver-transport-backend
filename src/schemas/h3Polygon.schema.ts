import { z } from "zod";
import { latitudeSchema, longitudeSchema, resolutionSchema } from "./h3.schema";

export const latLngPointSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
});

export const polygonToCellsSchema = z.object({
  boundary: z.array(latLngPointSchema).min(3, "boundary must have at least 3 points"),
  resolution: resolutionSchema,
});

export type PolygonToCellsRequest = z.infer<typeof polygonToCellsSchema>;
