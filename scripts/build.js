/**
 * Build script — wraps `next build` with fallback env vars.
 *
 * Vercel may not have DATABASE_URL configured as an environment variable.
 * Prisma requires a non-empty DATABASE_URL at build time. This script
 * forces a fallback if the var is missing or empty.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { execSync } = require("child_process");

// Force-set fallback env vars if missing OR empty
const FALLBACK_URL = "postgresql://build:build@localhost:5432/build";

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
  process.env.DATABASE_URL = FALLBACK_URL;
  console.log("[build] DATABASE_URL not set — using build-time fallback");
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.trim() === "") {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  console.log("[build] DIRECT_URL not set — using build-time fallback");
}

// Run next build with the env vars explicitly passed
// Use npx to ensure the next binary is found
try {
  execSync("npx next build", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      DIRECT_URL: process.env.DIRECT_URL,
    },
  });
} catch (err) {
  process.exit(1);
}
