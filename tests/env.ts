/**
 * Test env loader — ensures DATABASE_URL is loaded from .env before tests run.
 * Uses the POOLED connection with pgbouncer=true (Neon's recommended setup
 * for Prisma) + connect_timeout to handle cold starts.
 * Referenced in bunfig.toml as a preload.
 */

import { config } from "dotenv";
import { readFileSync } from "fs";
import { resolve } from "path";

// Force-load .env with override
config({ override: true });

// For tests: use pooled connection with pgbouncer + timeout for cold starts
try {
  const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  const vars: Record<string, string> = {};
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      vars[key] = value;
    }
  }
  // Use pooled connection (already has pgbouncer=true in DATABASE_URL)
  // Ensure connect_timeout is set for Neon cold starts
  let pooledUrl = vars.DATABASE_URL || "";
  if (pooledUrl && !pooledUrl.includes("connect_timeout")) {
    pooledUrl += (pooledUrl.includes("?") ? "&" : "?") + "connect_timeout=30";
  }
  // Use direct URL for DIRECT_URL (Prisma migrations/introspection)
  let directUrl = vars.DIRECT_URL || "";
  if (directUrl && !directUrl.includes("connect_timeout")) {
    directUrl += (directUrl.includes("?") ? "&" : "?") + "connect_timeout=30";
  }
  if (pooledUrl) process.env.DATABASE_URL = pooledUrl;
  if (directUrl) process.env.DIRECT_URL = directUrl;
} catch {
  // .env not found — rely on existing env
}

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith("postgresql://")) {
  console.error("DATABASE_URL not set to PostgreSQL. Tests require Neon PostgreSQL.");
  process.exit(1);
}
