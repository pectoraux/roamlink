/**
 * Authentication — provider-independent session-based auth.
 *
 * Stores sessions in the database (revocable, auditable). Cookies are signed
 * opaque tokens. Passwords are bcrypt-hashed. This module is the auth
 * abstraction boundary: swapping to NextAuth/OAuth would only require
 * replacing this layer.
 */

import { cookies } from "next/headers";
import { db } from "@/lib/db";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  isValidEmail,
  isStrongPassword,
} from "@/lib/security";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const SESSION_COOKIE = "esim_session";
const SESSION_TTL_DAYS = 30;

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  role: "customer" | "admin";
};

export type AuthResult = {
  user: AuthUser;
};

function toAuthUser(u: {
  id: string;
  email: string;
  name: string | null;
  role: string;
}): AuthUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as "customer" | "admin",
  };
}

/** Register a new customer. */
export async function registerCustomer(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) throw new AppError("validation", "Invalid email", 400, "Please enter a valid email address.");
  if (!isStrongPassword(input.password))
    throw new AppError("validation", "Password too weak", 400, "Password must be at least 8 characters.");

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw new AppError("conflict", "Email already registered", 409, "An account with this email already exists.");

  const passwordHash = await hashPassword(input.password);
  const user = await db.user.create({
    data: { email, name: input.name?.trim() || null, passwordHash, role: "customer" },
  });
  logger.info("user.registered", { userId: user.id, email });
  return toAuthUser(user);
}

/** Login with email/password and create a session. */
export async function login(input: {
  email: string;
  password: string;
  userAgent?: string;
  ip?: string;
}): Promise<{ user: AuthUser; token: string }> {
  const email = input.email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError("auth", "Invalid credentials", 401, "Invalid email or password.");
  }
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    throw new AppError("auth", "Invalid credentials", 401, "Invalid email or password.");
  }

  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.session.create({
    data: { userId: user.id, token, expiresAt, userAgent: input.userAgent, ip: input.ip },
  });
  logger.info("user.login", { userId: user.id });
  return { user: toAuthUser(user), token };
}

/** Logout the current session. */
export async function logout(token: string): Promise<void> {
  await db.session.deleteMany({ where: { token } }).catch(() => {});
}

/** Resolve a user from a session token. */
export async function getUserFromToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return toAuthUser(session.user);
}

/** Get the currently authenticated user (server component / route handler). */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return getUserFromToken(token);
}

/** Require an authenticated user or throw. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in to continue.");
  return user;
}

/** Require an admin user or throw. */
export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "admin")
    throw new AppError("authorization", "Forbidden", 403, "You do not have access to this area.");
  return user;
}

/** Set the session cookie on a response. */
export async function setSessionCookie(token: string) {
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

/** Clear the session cookie. */
export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Read the session token from a raw cookie header (for route handlers). */
export function readTokenFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Password reset + email verification architecture
// (Token generation + DB storage; delivery via NotificationService.)
// ---------------------------------------------------------------------------

export async function createPasswordResetToken(email: string): Promise<{ token: string; userId: string } | null> {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) return null; // do not leak existence
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
  await db.passwordResetToken.create({ data: { userId: user.id, token, expiresAt } });
  return { token, userId: user.id };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  if (!isStrongPassword(newPassword))
    throw new AppError("validation", "Password too weak", 400, "Password must be at least 8 characters.");
  const entry = await db.passwordResetToken.findUnique({ where: { token } });
  if (!entry || entry.expiresAt < new Date() || entry.usedAt)
    throw new AppError("auth", "Invalid or expired token", 400, "This password reset link is invalid or has expired.");
  const passwordHash = await hashPassword(newPassword);
  await db.$transaction([
    db.user.update({ where: { id: entry.userId }, data: { passwordHash } }),
    db.passwordResetToken.update({ where: { id: entry.id }, data: { usedAt: new Date() } }),
    db.session.deleteMany({ where: { userId: entry.userId } }),
  ]);
  logger.info("user.password_reset", { userId: entry.userId });
}

export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.emailVerificationToken.create({ data: { userId, token, expiresAt } });
  return token;
}

export async function verifyEmail(token: string): Promise<void> {
  const entry = await db.emailVerificationToken.findUnique({ where: { token } });
  if (!entry || entry.expiresAt < new Date())
    throw new AppError("auth", "Invalid token", 400, "This verification link is invalid or has expired.");
  await db.$transaction([
    db.user.update({ where: { id: entry.userId }, data: { emailVerified: new Date() } }),
    db.emailVerificationToken.delete({ where: { id: entry.id } }),
  ]);
  logger.info("user.email_verified", { userId: entry.userId });
}
