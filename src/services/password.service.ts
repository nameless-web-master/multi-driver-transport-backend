import bcrypt from "bcryptjs";

const ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plain, hashed);
}
