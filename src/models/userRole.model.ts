export const USER_ROLES = ["admin", "driver", "sender", "receiver"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PUBLIC_USER_ROLES = ["driver", "sender", "receiver"] as const;
export type PublicUserRole = (typeof PUBLIC_USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

export function isPublicUserRole(value: unknown): value is PublicUserRole {
  return typeof value === "string" && (PUBLIC_USER_ROLES as readonly string[]).includes(value);
}

/** Map legacy 'user' role values onto the new default of 'sender'. */
export function normalizeRole(value: unknown): UserRole {
  if (isUserRole(value)) return value;
  return "sender";
}
