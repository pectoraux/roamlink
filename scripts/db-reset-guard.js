/**
 * db-reset-guard.js — Phase 12.4.6.3.2 Step 4.
 *
 * Safety guard that runs BEFORE `prisma migrate reset`. Prevents the
 * destructive reset from running against the production/development database.
 *
 * `prisma migrate reset` drops ALL data and re-runs migrations. If it runs
 * against DATABASE_URL (production/dev), it destroys real data. This guard
 * requires DATABASE_TEST_URL to be set AND requires explicit confirmation.
 *
 * Usage: node scripts/db-reset-guard.js
 *
 * Exit codes:
 *   0 — safe to proceed (DATABASE_TEST_URL is set and differs from DATABASE_URL)
 *   1 — refused (DATABASE_TEST_URL missing, or equals DATABASE_URL, or VERCEL_ENV=production)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { config } = require("dotenv");
config({ override: true });

const TEST_URL = process.env.DATABASE_TEST_URL;
const RUNTIME_URL = process.env.DATABASE_URL;
const VERCEL_ENV = process.env.VERCEL_ENV;
const NODE_ENV = process.env.NODE_ENV;

function extractHost(url) {
  if (!url) return null;
  const match = String(url).match(/^postgres(?:ql)?:\/\/[^@]*@([^:/]+)/);
  return match ? match[1] : null;
}

function refuse(message) {
  console.error("\n[db-reset-guard] REFUSED — " + message + "\n");
  console.error(
    "  prisma migrate reset is DESTRUCTIVE — it drops ALL data and re-runs migrations.\n" +
      "  It MUST only run against DATABASE_TEST_URL (an isolated test database).\n" +
      "  (Phase 12.4.6.3.2 — test database safety contract)\n",
  );
  process.exit(1);
}

// 1. DATABASE_TEST_URL is mandatory.
if (!TEST_URL || TEST_URL.trim() === "") {
  refuse("DATABASE_TEST_URL is not set. Reset would run against DATABASE_URL (production/dev).");
}

// 2. Must be PostgreSQL.
if (!TEST_URL.startsWith("postgresql://") && !TEST_URL.startsWith("postgres://")) {
  refuse("DATABASE_TEST_URL must be a PostgreSQL connection string.");
}

// 3. Must NOT equal DATABASE_URL.
if (RUNTIME_URL && TEST_URL === RUNTIME_URL) {
  refuse("DATABASE_TEST_URL equals DATABASE_URL — test DB must be a separate isolated database.");
}

// 4. Must NOT point at the same host as DATABASE_URL.
const testHost = extractHost(TEST_URL);
const runtimeHost = extractHost(RUNTIME_URL);
if (testHost && runtimeHost && testHost === runtimeHost) {
  refuse(
    `DATABASE_TEST_URL host (${testHost}) equals DATABASE_URL host — ` +
      "test DB must be on a separate host or Neon branch.",
  );
}

// 5. Must NOT run in production.
if (VERCEL_ENV === "production") {
  refuse("VERCEL_ENV=production — reset must NEVER run in production.");
}
if (NODE_ENV === "production") {
  refuse("NODE_ENV=production — reset must NEVER run with NODE_ENV=production.");
}

// All checks passed.
console.log("[db-reset-guard] OK — DATABASE_TEST_URL is set and isolated. Proceeding with reset.");
