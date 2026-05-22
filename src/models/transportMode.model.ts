export const TRANSPORT_MODES = ["air", "land", "sea"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export function isTransportMode(value: unknown): value is TransportMode {
  return typeof value === "string" && (TRANSPORT_MODES as readonly string[]).includes(value);
}

export function normalizeTransportModes(modes: unknown): TransportMode[] {
  if (!Array.isArray(modes)) return [];
  const seen = new Set<TransportMode>();
  for (const m of modes) {
    if (isTransportMode(m)) seen.add(m);
  }
  return Array.from(seen);
}
