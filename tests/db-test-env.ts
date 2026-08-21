/**
 * Phase 12.4.6.3.2 — PostgreSQL Test Database Helper.
 *
 * Provides:
 *   - TEST_DB_MODE / IS_ISOLATED_TEST_DB — the effective test DB mode.
 *   - A unique slug generator for per-run isolation (prevents cross-test
 *     collisions when tests share a database).
 *   - A scoped cleanup helper that deletes ONLY rows created by this test run
 *     (never the destructive "delete all" pattern from the legacy helpers).
 *   - assertIsolatedTestDb() — fail-fast guard for destructive operations.
 *
 * TEST CLASS TAXONOMY (Phase 12.4.6.3.2 Step 7):
 *
 *   DB-AUTHORITY / DB-CONCURRENCY
 *     Tests that prove database concurrency semantics (fencing, unique
 *     constraints, conditional updateMany, FOR UPDATE). These MUST run on
 *     PostgreSQL via DATABASE_TEST_URL. No SQLite fallback. No production
 *     fallback.
 *
 *   PURE DOMAIN / UNIT
 *     Tests that exercise application logic without relying on DB concurrency
 *     primitives. These still require DATABASE_TEST_URL (the test database
 *     contract is mandatory for ALL database-backed tests).
 *
 *   SMOKE
 *     Explicit external Neon connection tests. May use DATABASE_TEST_URL or
 *     a dedicated NEON_SMOKE_URL — NEVER DATABASE_URL.
 */

import { db } from "@/lib/db";
import { IS_ISOLATED_TEST_DB, TEST_DB_MODE, assertIsolatedTestDb } from "./env";

export { IS_ISOLATED_TEST_DB, TEST_DB_MODE, assertIsolatedTestDb };

/**
 * Generate a unique slug for this test run. Uses a high-resolution timestamp
 * + random suffix so parallel test files do not collide.
 */
export function uniqueTestSlug(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Scoped cleanup — delete rows by their tenantId. This is the ONLY safe
 * cleanup pattern for shared databases. Never use `deleteMany({})` (the
 * legacy pattern) — it destroys ALL data including production seed data.
 *
 * Pass the tenantIds that this test created. The helper deletes child rows
 * first (respecting foreign-key order) then the tenant.
 */
export async function cleanupTenants(tenantIds: string[]): Promise<void> {
  // Fail fast — never run cleanup against a non-isolated database.
  assertIsolatedTestDb();

  const ids = tenantIds.filter(Boolean);
  if (ids.length === 0) return;

  // Rate-limit data (scoped to tenant).
  await db.rateLimitCounter
    .deleteMany({ where: { scopeId: { in: ids } } })
    .catch(() => {});
  await db.rateLimitEvent
    .deleteMany({ where: { tenantId: { in: ids } } })
    .catch(() => {});

  // Provider operation records (scoped to tenant).
  await db.providerOperationRecord
    .deleteMany({ where: { tenantId: { in: ids } } })
    .catch(() => {});

  // Idempotency operations (scoped by providerKey containing tenant slug
  // is not reliable — clean by scope if the test stored it).
  // Tests that create idempotency operations should clean them explicitly.

  // Tenant (cascades to most child relations via onDelete: Cascade).
  await db.tenant.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

/**
 * Assert that a test is running against PostgreSQL. Used by DB-AUTHORITY
 * tests to fail fast if the env is misconfigured (e.g. SQLite fallback).
 *
 * This calls assertIsolatedTestDb() first — if DATABASE_TEST_URL was missing
 * or unsafe, this throws TestDatabaseSafetyError before any query is made.
 */
export function assertPostgres(): void {
  // First, enforce the isolated-test-DB contract (hard gate).
  assertIsolatedTestDb();

  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
    throw new Error(
      `DB-AUTHORITY test requires PostgreSQL. Got DATABASE_URL prefix: "${url.slice(0, 20)}...". ` +
        "Set DATABASE_TEST_URL to an isolated PostgreSQL connection string.",
    );
  }
}
