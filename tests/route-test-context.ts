/**
 * Route Test Context — lets tests invoke Next.js App Router route handlers
 * DIRECTLY (not via a simulated re-implementation of their logic).
 *
 * The Phase 11+ standard requires boundary tests to exercise the REAL route
 * handler, not a simulation of its filtering. But route handlers call
 * `getCurrentUser()` which reads the session token from `cookies()` exported
 * by `next/headers`. In a test process there is no HTTP request, so the
 * Next.js AsyncLocalStorage request context is empty and `cookies()` throws.
 *
 * This helper registers a `mock.module("next/headers", ...)` that returns a
 * controllable cookie store. Tests then call `setMockSessionToken(token)`
 * before invoking the route handler, and the route reads exactly that token.
 *
 * CRITICAL: this module must be imported BEFORE any module that transitively
 * imports `next/headers` (i.e. before `@/lib/auth`, `@/lib/tenant/context`,
 * or any route handler). Bun's `mock.module()` must be registered before the
 * real module is first imported so the mock is used. Import this helper as
 * the FIRST import in any test file that invokes route handlers.
 *
 * Usage:
 *   import "./route-test-context";                       // registers the mock
 *   import { setMockSessionToken } from "./route-test-context";
 *   import { GET } from "@/app/api/v1/connectivity/sessions/route";
 *
 *   setMockSessionToken(sessionToken);
 *   const res = await GET();
 *   expect(res.status).toBe(200);
 */

import { mock } from "bun:test";

// The mutable cookie store. Only the `esim_session` cookie is needed for auth,
// but we keep a generic store so any future `cookies().set()` (e.g. tenant
// switch) is also captured.
let cookieStore: Record<string, string> = {};

mock.module("next/headers", () => {
  return {
    /**
     * `cookies()` in Next.js 16 returns a Promise<ReadonlyRequestCookies>.
     * Our mock returns a thenable that resolves to a minimal cookie store
     * implementing the subset of the API used by `@/lib/auth` and
     * `@/lib/tenant/context`.
     */
    cookies: () =>
      Promise.resolve({
        get(name: string) {
          const value = cookieStore[name];
          if (value === undefined) return undefined;
          return { name, value };
        },
        getAll() {
          return Object.entries(cookieStore).map(([name, value]) => ({ name, value }));
        },
        set(name: string, value: string) {
          cookieStore[name] = value;
        },
        delete(name: string) {
          delete cookieStore[name];
        },
        // Next.js 16 also has `has(name)` on the cookie store.
        has(name: string) {
          return cookieStore[name] !== undefined;
        },
      }),
    // `headers()` is also used by some Next.js internals; provide a minimal mock.
    headers: () =>
      Promise.resolve({
        get(name: string) {
          if (name.toLowerCase() === "x-forwarded-for") return "127.0.0.1";
          return null;
        },
        has() {
          return false;
        },
      }),
  };
});

/**
 * Set (or clear) the `esim_session` cookie token used by `getCurrentUser()`.
 * Pass `null` to simulate an unauthenticated request.
 */
export function setMockSessionToken(token: string | null) {
  if (token === null) {
    delete cookieStore["esim_session"];
  } else {
    cookieStore["esim_session"] = token;
  }
}

/**
 * Reset the entire cookie store (for test isolation).
 */
export function resetMockCookies() {
  cookieStore = {};
}
