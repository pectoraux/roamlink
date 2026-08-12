/**
 * Test env loader — ensures DATABASE_URL is loaded from .env before tests run.
 *
 * Phase 2D: the canonical database is PostgreSQL (Neon). Tests execute
 * against the real PostgreSQL database. Referenced in bunfig.toml as a preload.
 */

import { config } from "dotenv";

// Force-load .env with override
config({ override: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill in the PostgreSQL connection string.");
  process.exit(1);
}

if (!process.env.DATABASE_URL.startsWith("postgresql://") && !process.env.DATABASE_URL.startsWith("postgres://")) {
  console.error(
    "DATABASE_URL must point to a PostgreSQL database. Got: " +
      process.env.DATABASE_URL,
  );
  process.exit(1);
}
