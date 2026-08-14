-- Phase 2B.2.6 — Deterministic transaction ordering
-- Adds sequenceNumber to TenantTransaction for per-tenant monotonic ordering.

-- Step 1: Add the column with a default of 0
ALTER TABLE "TenantTransaction" ADD COLUMN "sequenceNumber" INTEGER NOT NULL DEFAULT 0;

-- Step 2: Assign existing rows a per-tenant sequence based on creation order.
-- Use ROW_NUMBER() ordered by createdAt to give each existing transaction
-- a unique per-tenant sequence number.
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY "tenantId" ORDER BY "createdAt" ASC) AS seq
  FROM "TenantTransaction"
)
UPDATE "TenantTransaction" t
SET "sequenceNumber" = ranked.seq
FROM ranked
WHERE t.id = ranked.id;

-- Step 3: Create a unique index to enforce per-tenant sequence uniqueness
CREATE UNIQUE INDEX "TenantTransaction_tenantId_sequenceNumber_key" ON "TenantTransaction"("tenantId", "sequenceNumber");
