/**
 * Test env loader — ensures DATABASE_URL is loaded from .env before tests run.
 *
 * Phase 9.1: supports both PostgreSQL (production/ci) and SQLite (local dev).
 */

import { config } from "dotenv";

// Force-load .env with override
config({ override: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill in the connection string.");
  process.exit(1);
}
