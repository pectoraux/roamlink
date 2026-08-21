/**
 * Test env loader — Phase 12.4.6.3.1 PostgreSQL Test Harness.
 *
 * Loads .env, then resolves the EFFECTIVE test database connection.
 *
 * THREE DATABASE MODES (Phase 12.4.6.3.1 Step 1):
 *
 *   A. Development database     → Neon PostgreSQL (.env DATABASE_URL)
 *   B. Production database       → Neon PostgreSQL (.env DATABASE_URL)
 *   C. Automated test database   → isolated PostgreSQL (DATABASE_TEST_URL)
 *
 * The test database MUST be separate from production. If DATABASE_TEST_URL is
 * set, it overrides DATABASE_URL for the test process. If it is NOT set,
 * tests fall back to DATABASE_URL and print a loud warning — this is allowed
 * only for the small PostgreSQL-authority matrix + smoke tests that use
 * strict per-run isolation (unique tenant slugs, scoped cleanup). The full
 * regression suite MUST be pointed at DATABASE_TEST_URL.
 *
 * SQLite is NOT used as a substitute for PostgreSQL concurrency proof.
 */

import { config } from "dotenv";

// Force-load .env with override.
config({ override: true });

// --- Resolve test database ---------------------------------------------------
//
// DATABASE_TEST_URL / DIRECT_TEST_URL point at an isolated PostgreSQL database
// (preferred: a dedicated Neon branch/database). When present, they override
// the runtime DATABASE_URL / DIRECT_URL so tests never touch production data.
const TEST_URL = process.env.DATABASE_TEST_URL;
const TEST_DIRECT = process.env.DIRECT_TEST_URL;

if (TEST_URL) {
  // Isolated test database configured — use it.
  process.env.DATABASE_URL = TEST_URL;
  if (TEST_DIRECT) {
    process.env.DIRECT_URL = TEST_DIRECT;
  }
} else if (process.env.DATABASE_URL) {
  // No test DB configured — falling back to the .env DATABASE_URL.
  // This is acceptable ONLY for:
  //   - The PostgreSQL-authority matrix (12.4.6.3.1.1–1.6) — small, isolated.
  //   - Neon smoke tests.
  // The full regression suite should set DATABASE_TEST_URL.
  console.warn(
    "\n[tests/env.ts] WARNING: DATABASE_TEST_URL is not set. Tests will run " +
      "against DATABASE_URL from .env.\n" +
      "  - For the PostgreSQL-authority matrix + smoke tests: this is acceptable " +
      "(strict per-run isolation is used).\n" +
      "  - For the full regression suite: set DATABASE_TEST_URL to an isolated " +
      "PostgreSQL database (Neon branch or dedicated DB).\n" +
      "  SQLite is NOT used as a substitute for PostgreSQL concurrency proof.\n",
  );
} else {
  console.error(
    "DATABASE_URL (or DATABASE_TEST_URL) is not set. " +
      "Copy .env.example to .env and fill in the connection string.",
  );
  process.exit(1);
}

// --- Expose the effective test DB mode for assertion by tests ----------------

export type TestDbMode =
  | "isolated_test_db" // DATABASE_TEST_URL is set → isolated PostgreSQL
  | "shared_runtime_db"; // falling back to .env DATABASE_URL

export const TEST_DB_MODE: TestDbMode = TEST_URL
  ? "isolated_test_db"
  : "shared_runtime_db";

export const IS_ISOLATED_TEST_DB = TEST_DB_MODE === "isolated_test_db";
