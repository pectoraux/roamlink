/**
 * Test env loader — ensures DATABASE_URL is loaded from .env before tests run.
 *
 * In the Phase 2C convergence the canonical database is SQLite
 * (file:/home/z/my-project/db/custom.db). Tests execute against the real
 * SQLite database. Referenced in bunfig.toml as a preload.
 */

import { config } from "dotenv";

// Force-load .env with override
config({ override: true });

if (!process.env.DATABASE_URL) {
  // Fallback to the canonical sandbox SQLite database.
  process.env.DATABASE_URL = "file:/home/z/my-project/db/custom.db";
}

if (!process.env.DATABASE_URL.startsWith("file:")) {
  console.error(
    "DATABASE_URL must point to a SQLite file: URL for Phase 2C tests. Got: " +
      process.env.DATABASE_URL,
  );
  process.exit(1);
}
