import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import type { AuthUser } from "@/lib/auth";

/** Get the current user in a route handler. */
export async function getRouteUser(): Promise<AuthUser | null> {
  return getCurrentUser();
}

export async function requireRouteUser() {
  const user = await getRouteUser();
  if (!user) {
    const err = new Error("Not authenticated");
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }
  return user;
}

export async function requireRouteAdmin() {
  const user = await requireRouteUser();
  if (user.role !== "admin") {
    const err = new Error("Forbidden");
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
  return user;
}

export function readBody<T = unknown>(req: NextRequest): Promise<T> {
  return req.json() as Promise<T>;
}
