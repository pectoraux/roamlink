/**
 * Phase 12.4.6.3.2 — Test Database Safety Guard (pure functions, no side effects).
 *
 * This module contains ONLY the validation logic. It does NOT read .env, does
 * NOT mutate process.env, and does NOT connect to any database. This makes it
 * safe to import from adversarial tests that need to invoke the guard with
 * synthetic configurations.
 *
 * The actual env loading + guard execution happens in tests/env.ts, which
 * imports validateTestDatabaseEnv from this module.
 */

/**
 * Error thrown when the test database configuration is unsafe.
 * Tests catch this to prove the guard rejects bad configurations.
 */
export class TestDatabaseSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseSafetyError";
  }
}

/**
 * Extract the hostname from a PostgreSQL connection string.
 * Returns null if the URL doesn't match the expected format.
 */
function extractHost(url: string): string | null {
  try {
    const match = url.match(/^postgres(?:ql)?:\/\/[^@]*@([^:/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Validate that the test database configuration is safe. Throws
 * TestDatabaseSafetyError if any check fails. Returns the effective test
 * database URL + direct URL on success.
 *
 * Checks (Phase 12.4.6.3.2 Step 2):
 *   1. DATABASE_TEST_URL is mandatory (no fallback to DATABASE_URL).
 *   2. DATABASE_TEST_URL must NOT equal DATABASE_URL.
 *   3. VERCEL_ENV=production → refuse (tests never run in production).
 *   4. DATABASE_TEST_URL must be PostgreSQL (not SQLite).
 *   5. DATABASE_TEST_URL must NOT point to the same host as DATABASE_URL.
 *   6. NODE_ENV=production → refuse.
 *
 * @param env The environment to validate (defaults to process.env). Tests
 *   pass synthetic configurations here.
 */
export function validateTestDatabaseEnv(
  env: NodeJS.ProcessEnv = process.env,
): { testUrl: string; testDirectUrl: string } {
  const testUrl = env.DATABASE_TEST_URL;
  const runtimeUrl = env.DATABASE_URL;
  const vercelEnv = env.VERCEL_ENV;
  const nodeEnv = env.NODE_ENV;

  // 1. DATABASE_TEST_URL is MANDATORY. No fallback to DATABASE_URL.
  if (!testUrl || testUrl.trim() === "") {
    throw new TestDatabaseSafetyError(
      "DATABASE_TEST_URL is required for database-backed tests.\n" +
        "  The test suite contains deleteMany, migrations, and destructive fixtures —\n" +
        "  it MUST NOT run against DATABASE_URL (the development/production database).\n" +
        "  Set DATABASE_TEST_URL to an isolated PostgreSQL database (Neon branch or\n" +
        "  dedicated test DB). Do not silently substitute DATABASE_URL.\n" +
        "  (Phase 12.4.6.3.2 — test database safety contract)",
    );
  }

  // 2. DATABASE_TEST_URL must NOT equal DATABASE_URL.
  if (runtimeUrl && testUrl === runtimeUrl) {
    throw new TestDatabaseSafetyError(
      "DATABASE_TEST_URL must NOT equal DATABASE_URL.\n" +
        "  The test database must be a SEPARATE isolated database — using the same\n" +
        "  connection string as the runtime database would let tests destroy production\n" +
        "  data. Set DATABASE_TEST_URL to a different isolated PostgreSQL database.\n" +
        "  (Phase 12.4.6.3.2 — test/production database separation)",
    );
  }

  // 3. Tests must NEVER run when VERCEL_ENV=production.
  if (vercelEnv === "production") {
    throw new TestDatabaseSafetyError(
      "VERCEL_ENV=production — tests must NEVER run in the production environment.\n" +
        "  The test suite contains destructive operations (deleteMany, migrations).\n" +
        "  Refusing to initialize even with DATABASE_TEST_URL set, because the\n" +
        "  production runtime environment is not a safe context for test execution.\n" +
        "  (Phase 12.4.6.3.2 — production environment guard)",
    );
  }

  // 4. DATABASE_TEST_URL must be PostgreSQL (not SQLite).
  if (
    !testUrl.startsWith("postgresql://") &&
    !testUrl.startsWith("postgres://")
  ) {
    throw new TestDatabaseSafetyError(
      `DATABASE_TEST_URL must be a PostgreSQL connection string.\n` +
        `  Got prefix: "${testUrl.slice(0, 20)}...".\n` +
        `  SQLite is NOT used as a substitute for PostgreSQL concurrency proof.\n` +
        `  (Phase 12.4.6.3.2 — PostgreSQL-only test database)`,
    );
  }

  // 5. DATABASE_TEST_URL must NOT point at the same host as DATABASE_URL.
  if (runtimeUrl) {
    const testHost = extractHost(testUrl);
    const runtimeHost = extractHost(runtimeUrl);
    if (testHost && runtimeHost && testHost === runtimeHost) {
      throw new TestDatabaseSafetyError(
        `DATABASE_TEST_URL points to the same host as DATABASE_URL (${testHost}).\n` +
          `  The test database must be on a SEPARATE host or Neon branch.\n` +
          `  (Phase 12.4.6.3.2 — test/production host separation)`,
      );
    }
  }

  // 6. NODE_ENV must NOT be "production".
  if (nodeEnv === "production") {
    throw new TestDatabaseSafetyError(
      "NODE_ENV=production — tests must NEVER run with NODE_ENV=production.\n" +
        "  (Phase 12.4.6.3.2 — production environment guard)",
    );
  }

  // Resolve DIRECT_TEST_URL (optional but recommended for migrations in tests).
  const testDirectUrl = env.DIRECT_TEST_URL || testUrl;

  return { testUrl, testDirectUrl };
}
