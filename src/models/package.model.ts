export const PACKAGE_TYPES = [
  "letter",
  "extra_small",
  "small",
  "medium_small",
  "medium",
  "medium_large",
  "large",
  "extra_large",
  "other",
] as const;

export type PackageType = (typeof PACKAGE_TYPES)[number];

export const MAX_PACKAGES = 6;

export interface OrderPackageEntry {
  package_type: PackageType;
  weight_lbs: number;
  package_length: number;
  package_width: number;
  package_height: number;
}

export interface OrderPackageLegacyTotals {
  weight_lbs?: number | null;
  package_length?: number | null;
  package_width?: number | null;
  package_height?: number | null;
}

export const PACKAGE_TYPE_LABELS: Record<PackageType, string> = {
  letter: "Letter",
  extra_small: "Extra Small",
  small: "Small",
  medium_small: "Medium-small",
  medium: "Medium",
  medium_large: "Medium-large",
  large: "Large",
  extra_large: "Extra Large",
  other: "Other",
};

/** Client-defined multipliers applied to base cost. */
export const PACKAGE_FACTORS: Record<PackageType, number> = {
  letter: 0.01,
  extra_small: 0.01,
  small: 0.02,
  medium_small: 0.022,
  medium: 0.05,
  medium_large: 0.09,
  large: 0.2,
  extra_large: 0.6,
  other: 0.05,
};

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function positiveNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function packageFactorForType(type: PackageType): number {
  return PACKAGE_FACTORS[type];
}

export function totalPackageFactorForTypes(types: readonly PackageType[]): number {
  return types.reduce((sum, type) => sum + packageFactorForType(type), 0);
}

export function totalPackageFactorForEntries(packages: readonly OrderPackageEntry[]): number {
  return totalPackageFactorForTypes(packages.map((p) => p.package_type));
}

export function formatPackageDimensions(entry: Pick<OrderPackageEntry, "package_length" | "package_width" | "package_height">): string {
  return `${entry.package_length} × ${entry.package_width} × ${entry.package_height} in`;
}

export function rollupOrderTotalsFromPackages(packages: readonly OrderPackageEntry[]): {
  weight_lbs: number;
  package_length: number;
  package_width: number;
  package_height: number;
  dimensions: string;
} {
  const weight_lbs = round3(packages.reduce((sum, p) => sum + p.weight_lbs, 0));
  const package_length = Math.max(...packages.map((p) => p.package_length));
  const package_width = Math.max(...packages.map((p) => p.package_width));
  const package_height = Math.max(...packages.map((p) => p.package_height));
  const dimensions =
    packages.length === 1
      ? formatPackageDimensions(packages[0])
      : packages
          .map((p, i) => `#${i + 1}: ${formatPackageDimensions(p)}`)
          .join(" · ");

  return { weight_lbs, package_length, package_width, package_height, dimensions };
}

export function defaultOrderPackageEntry(type: PackageType = "medium"): OrderPackageEntry {
  return {
    package_type: type,
    weight_lbs: 1,
    package_length: 1,
    package_width: 1,
    package_height: 1,
  };
}

function parsePackageEntry(
  item: unknown,
  legacy?: OrderPackageLegacyTotals
): OrderPackageEntry | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  if (!isPackageType(row.package_type)) return null;

  const weight_lbs = positiveNumber(row.weight_lbs) ?? positiveNumber(legacy?.weight_lbs);
  const package_length =
    positiveNumber(row.package_length) ?? positiveNumber(legacy?.package_length);
  const package_width = positiveNumber(row.package_width) ?? positiveNumber(legacy?.package_width);
  const package_height =
    positiveNumber(row.package_height) ?? positiveNumber(legacy?.package_height);

  if (
    weight_lbs == null ||
    package_length == null ||
    package_width == null ||
    package_height == null
  ) {
    return null;
  }

  return {
    package_type: row.package_type,
    weight_lbs,
    package_length,
    package_width,
    package_height,
  };
}

export function normalizeOrderPackages(
  packages: Partial<OrderPackageEntry>[] | undefined,
  legacyType?: PackageType | null,
  legacyTotals?: OrderPackageLegacyTotals
): OrderPackageEntry[] {
  if (packages && packages.length > 0) {
    const parsed = packages
      .map((item) => parsePackageEntry(item, legacyTotals))
      .filter((item): item is OrderPackageEntry => item != null);
    if (parsed.length > 0) {
      return parsed.slice(0, MAX_PACKAGES);
    }
  }
  const type = legacyType ?? "medium";
  const fromLegacy = parsePackageEntry({ package_type: type }, legacyTotals);
  return [fromLegacy ?? defaultOrderPackageEntry(type)];
}

export function isPackageType(value: unknown): value is PackageType {
  return typeof value === "string" && (PACKAGE_TYPES as readonly string[]).includes(value);
}

export function parseOrderPackagesFromStorage(
  raw: unknown,
  legacyType?: PackageType | null,
  legacyTotals?: OrderPackageLegacyTotals
): OrderPackageEntry[] {
  if (raw != null) {
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) {
      const applyLegacy = parsed.length === 1 ? legacyTotals : undefined;
      const entries = parsed
        .map((item) => parsePackageEntry(item, applyLegacy))
        .filter((item): item is OrderPackageEntry => item != null);
      if (entries.length > 0) {
        return entries.slice(0, MAX_PACKAGES);
      }
    }
  }
  return normalizeOrderPackages(undefined, legacyType, legacyTotals);
}
