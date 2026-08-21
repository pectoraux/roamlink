#!/usr/bin/env node
/**
 * ci-safety-check.js — Phase 12.4.6.3.3 Step 11.
 *
 * CI environment assertions. Runs BEFORE any test or migration in CI.
 * Fails the workflow immediately if the CI environment is unsafe.
 *
 * Checks:
 *   1. VERCEL_ENV must NOT be "production"
 *   2. DATABASE_TEST_URL must be set and PostgreSQL
 *   3. DATABASE_TEST_URL must NOT equal DATABASE_URL
 *   4. DATABASE_TEST_URL must NOT equal DIRECT_URL
 *   5. NODE_ENV must NOT be "production"
 *
 * Exit codes:
 *   0 — safe to proceed
 *   1 — refused (printed to stderr)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { config } = require("dotenv");
config({ override: true });

function extractHost(url) {
  if (!url) return null;
  const match = String(url).match(/^postgres(?:ql)?:\/\/[^@]*@([^:/]+)/);
  return match ? match[1] : null;
}

function refuse(message) {
  console.error("\n[ci-safety-check] REFUSED — " + message + "\n");
  console.error(
    "  CI environment is unsafe. Aborting before any test or migration.\n" +
      "  (Phase 12.4.6.3.3 — CI safety assertions)\n",
  );
  process.exit(1);
}

const TEST_URL = process.env.DATABASE_TEST_URL;
const RUNTIME_URL = process.env.DATABASE_URL;
const DIRECT_URL = process.env.DIRECT_URL;
const VERCEL_ENV = process.env.VERCEL_ENV;
const NODE_ENV = process.env.NODE_ENV;

// 1. VERCEL_ENV must NOT be production.
if (VERCEL_ENV === "production") {
  refuse("VERCEL_ENV=production — CI must never run in production.");
}

// 2. NODE_ENV must NOT be production.
if (NODE_ENV === "production") {
  refuse("NODE_ENV=production — CI must never run with NODE_ENV=production.");
}

// 3. DATABASE_TEST_URL must be set.
if (!TEST_URL || TEST_URL.trim() === "") {
  refuse("DATABASE_TEST_URL is not set. CI requires an isolated test PostgreSQL.");
}

// 4. DATABASE_TEST_URL must be PostgreSQL.
if (!TEST_URL.startsWith("postgresql://") && !TEST_URL.startsWith("postgres://")) {
  refuse(
    `DATABASE_TEST_URL must be PostgreSQL. Got prefix: "${TEST_URL.slice(0, 20)}...".`,
  );
}

// 5. DATABASE_TEST_URL must NOT equal DATABASE_URL.
if (RUNTIME_URL && TEST_URL === RUNTIME_URL) {
  refuse("DATABASE_TEST_URL equals DATABASE_URL — test DB must differ from runtime DB.");
}

// 6. DATABASE_TEST_URL must NOT equal DIRECT_URL.
if (DIRECT_URL && TEST_URL === DIRECT_URL) {
  refuse("DATABASE_TEST_URL equals DIRECT_URL — test DB must differ from migration DB.");
}

// 7. Host separation (best-effort).
const testHost = extractHost(TEST_URL);
const runtimeHost = extractHost(RUNTIME_URL);
if (testHost && runtimeHost && testHost === runtimeHost) {
  refuse(
    `DATABASE_TEST_URL host (${testHost}) equals DATABASE_URL host — test DB must be isolated.`,
  );
}

console.log("[ci-safety-check] OK — CI environment is safe.");
console.log("  DATABASE_TEST_URL: set (PostgreSQL)");
console.log("  VERCEL_ENV: " + (VERCEL_ENV || "(unset)"));
console.log("  NODE_ENV: " + (NODE_ENV || "(unset)"));
