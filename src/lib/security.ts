/**
 * Security helpers.
 */

import bcrypt from "bcryptjs";
import { randomBytes, timingSafeEqual } from "crypto";

/** Hash a password using bcrypt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(password, salt);
}

/** Verify a password against a bcrypt hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Generate a cryptographically random opaque token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/** Constant-time string comparison (for tokens / signatures). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Basic email validation. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Basic password strength check. */
export function isStrongPassword(password: string): boolean {
  return password.length >= 8;
}
