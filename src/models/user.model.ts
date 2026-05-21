/**
 * Database-level shape for `users`. Internal use only — never expose
 * `hashed_password` over the API surface. Use `PublicUser` for responses.
 */
export interface UserRow {
  id: number;
  full_name: string;
  company_name: string;
  email: string;
  hashed_password: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PublicUser {
  id: number;
  full_name: string;
  company_name: string;
  email: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserCreateInput {
  full_name: string;
  company_name: string;
  email: string;
  hashed_password: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    full_name: row.full_name,
    company_name: row.company_name,
    email: row.email,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
