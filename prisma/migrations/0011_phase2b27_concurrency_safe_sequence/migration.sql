-- Phase 2B.2.7 — Concurrency-safe sequence allocation
-- Adds nextTransactionSequence to TenantBalance for per-tenant FOR UPDATE sequencing.

-- Step 1: Add the column with a default of 1
ALTER TABLE "TenantBalance" ADD COLUMN "nextTransactionSequence" INTEGER NOT NULL DEFAULT 1;

-- Step 2: Initialize existing tenants so nextTransactionSequence = MAX(existing sequence) + 1
-- This ensures future allocations don't collide with existing transactions.
UPDATE "TenantBalance" tb
SET "nextTransactionSequence" = COALESCE(
  (SELECT MAX("sequenceNumber") + 1 FROM "TenantTransaction" tt WHERE tt."tenantId" = tb."tenantId"),
  1
);
