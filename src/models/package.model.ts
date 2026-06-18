export const PACKAGE_TYPES = [
  "letter",
  "extra_small",
  "small",
  "medium_small",
  "medium",
  "medium_large",
  "large",
  "extra_large",
] as const;

export type PackageType = (typeof PACKAGE_TYPES)[number];

export const PACKAGE_TYPE_LABELS: Record<PackageType, string> = {
  letter: "Letter",
  extra_small: "Extra Small",
  small: "Small",
  medium_small: "Medium-small",
  medium: "Medium",
  medium_large: "Medium-large",
  large: "Large",
  extra_large: "Extra Large",
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
};

export function packageFactorForType(type: PackageType): number {
  return PACKAGE_FACTORS[type];
}

export function isPackageType(value: unknown): value is PackageType {
  return typeof value === "string" && (PACKAGE_TYPES as readonly string[]).includes(value);
}
