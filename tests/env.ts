/**
 * Test env loader — Phase 12.4.6.3.2 Test Database Safety.
 *
 * SECURITY CONTRACT (NON-NEGOTIABLE):
 *
 *   A test suite containing `deleteMany`, schema migrations, cleanup, destructive
 *   fixtures, and concurrency tests MUST NEVER automatically connect to the
 *   production Neon database.
 *
 *   if DATABASE_TEST_URL is absent
 *       ↓
 *   DB-backed tests FAIL FAST (via assertIsolatedTestDb, before any query)
 *
 *   Never:
 *     DATABASE_TEST_URL missing
 *         ↓
 *     use DATABASE_URL
 *         ↓
 *     possibly destroy production data
 *
 * THREE DATABASE MODES (Phase 12.4.6.3.2 Step 1):
 *
 *   DEVELOPMENT  → DATABASE_URL      = Neon development database
 *   PRODUCTION   → DATABASE_URL      = Neon production database
 *   TEST         → DATABASE_TEST_URL = isolated test PostgreSQL database (MANDATORY)
 *
 * IMPLEMENTATION:
 *   This module runs as a preload (bunfig.toml) before all tests. It validates
 *   the test DB configuration:
 *
 *     - If DATABASE_TEST_URL is valid + isolated → overrides DATABASE_URL with
 *       the test URL. DB-backed tests connect to the isolated test DB.
 *
 *     - If DATABASE_TEST_URL is missing/unsafe → sets a global flag
 *       `__TEST_DB_UNSAFE__ = true` and does NOT override DATABASE_URL. This
 *       allows the pure-logic safety tests (which don't connect to a DB) to
 *       run and prove the guard. DB-backed tests call assertIsolatedTestDb()
 *       which checks the flag and throws before any query is made.
 *
 *   This dual behavior is necessary because:
 *     1. The safety guard must be provable WITHOUT a database (the whole point
 *        of the adversarial tests).
 *     2. DB-backed tests must never silently run against production.
 *
 * SQLite is NOT used as a substitute for PostgreSQL concurrency proof.
 */

import { config } from "dotenv";
import {
  validateTestDatabaseEnv,
  TestDatabaseSafetyError,
} from "./safety-guard";

// Re-export for tests that import from env.ts.
export { validateTestDatabaseEnv, TestDatabaseSafetyError };

// Force-load .env with override.
config({ override: true });

// ---------------------------------------------------------------------------
// Run the safety guard.
// ---------------------------------------------------------------------------
const GLOBAL_FLAG = "__TEST_DB_UNSAFE__";
let validatedTestUrl: string | null = null;
let validationError: TestDatabaseSafetyError | null = null;

try {
  const { testUrl, testDirectUrl } = validateTestDatabaseEnv(process.env);
  // Guard passed — configure the process to use the isolated test database.
  process.env.DATABASE_URL = testUrl;
  process.env.DIRECT_URL = testDirectUrl;
  validatedTestUrl = testUrl;
  // Clear the unsafe flag (validated successfully).
  (globalThis as any)[GLOBAL_FLAG] = false;
} catch (err) {
  if (err instanceof TestDatabaseSafetyError) {
    // Guard FAILED — set the unsafe flag. Do NOT override DATABASE_URL.
    // DB-backed tests will call assertIsolatedTestDb() which checks this flag
    // and throws. Pure-logic tests (safety tests) can still run.
    validationError = err;
    (globalThis as any)[GLOBAL_FLAG] = true;
  } else {
    throw err;
  }
}

// Export the resolved configuration for assertions by tests.
export const TEST_DB_URL = validatedTestUrl;
export const TEST_DB_DIRECT_URL = validatedTestUrl;
export const TEST_DB_MODE: "isolated_test_db" | "unsafe" = validatedTestUrl
  ? "isolated_test_db"
  : "unsafe";
export const IS_ISOLATED_TEST_DB = validatedTestUrl !== null;

/**
 * Assert that the current process is running against the isolated test database.
 * Used by destructive test setup (deleteMany, migrations) and DB-backed tests
 * to fail fast if the guard was bypassed or DATABASE_TEST_URL was missing.
 *
 * This is the HARD GATE — every DB-backed test + destructive helper MUST call
 * this before touching the database. If the unsafe flag is set, this throws
 * TestDatabaseSafetyError with the original validation error message.
 */
export function assertIsolatedTestDb(): void {
  if ((globalThis as any)[GLOBAL_FLAG] === true) {
    throw (
      validationError ||
      new TestDatabaseSafetyError(
        "Test database is unsafe (DATABASE_TEST_URL missing or invalid). " +
          "DB-backed tests cannot run.",
      )
    );
  }
  // Re-validate — catches any post-load env mutation.
  validateTestDatabaseEnv(process.env);
}
