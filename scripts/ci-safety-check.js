#!/usr/bin/env node
/**
 * ci-safety-check.js — Phase 12.4.6.3.3 Step 11.
 *
 * CI environment assertions. Runs BEFORE any test or migration in CI.
 * Fails the workflow immediately if the CI environment is unsafe.
 *
 * This script has NO dependencies (no dotenv require) so it can run before
 * `npm install` / `bun install`. It reads process.env directly.
 *
 * Checks:
 *   1. VERCEL_ENV must NOT be "production"
 *   2. NODE_ENV must NOT be "production"
 *   3. DATABASE_TEST_URL must be set and PostgreSQL
 *   4. If DATABASE_URL is set, it must NOT be a production Neon host
 *      (CI uses a service container — DATABASE_URL points at the test container)
 *
 * Exit codes:
 *   0 — safe to proceed
 *   1 — refused (printed to stderr)
 */

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
if (
  !TEST_URL.startsWith("postgresql://") &&
  !TEST_URL.startsWith("postgres://")
) {
  refuse(
    `DATABASE_TEST_URL must be PostgreSQL. Got prefix: "${TEST_URL.slice(0, 20)}...".`,
  );
}

// 5. In CI, DATABASE_URL / DIRECT_URL point at the test container (same host).
//    This is safe because:
//      - VERCEL_ENV is not production
//      - The host is localhost (service container), not a production Neon host
//    The guard does NOT require DATABASE_URL to differ from DATABASE_TEST_URL
//    in CI — it requires that neither points at a production host.
//
//    Production hosts are identified by the Neon domain pattern:
//      *.aws.neon.tech  (excluding the test branch if one exists)
//
//    If DATABASE_URL points at *.aws.neon.tech in CI, that's a P0 — CI must
//    only connect to the service container.

function isNeonHost(url) {
  const host = extractHost(url);
  if (!host) return false;
  return host.endsWith(".aws.neon.tech") || host.endsWith(".neon.tech");
}

if (RUNTIME_URL && isNeonHost(RUNTIME_URL)) {
  refuse(
    `DATABASE_URL points at a Neon host (${extractHost(RUNTIME_URL)}) — ` +
      "CI must ONLY use the service container (localhost), never a Neon production host.",
  );
}

if (DIRECT_URL && isNeonHost(DIRECT_URL)) {
  refuse(
    `DIRECT_URL points at a Neon host (${extractHost(DIRECT_URL)}) — ` +
      "CI must ONLY use the service container (localhost), never a Neon production host.",
  );
}

console.log("[ci-safety-check] OK — CI environment is safe.");
console.log("  DATABASE_TEST_URL: " + (TEST_URL ? "set (PostgreSQL)" : "MISSING"));
console.log("  DATABASE_URL: " + (RUNTIME_URL ? extractHost(RUNTIME_URL) || "set" : "(unset)"));
console.log("  DIRECT_URL: " + (DIRECT_URL ? extractHost(DIRECT_URL) || "set" : "(unset)"));
console.log("  VERCEL_ENV: " + (VERCEL_ENV || "(unset)"));
console.log("  NODE_ENV: " + (NODE_ENV || "(unset)"));
