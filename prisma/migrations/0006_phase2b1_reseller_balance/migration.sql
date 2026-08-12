-- Phase 2B.1 — Reseller Balance & Transactions
-- Adds: TenantBalance, TenantTransaction models
-- Extends: chart of accounts (RESELLER_FUNDS_LIABILITY 2300, PLATFORM_FEE_REVENUE 4100, SAAS_SUBSCRIPTION_REVENUE 4200)

-- The new ledger accounts are created idempotently by ensureChartOfAccounts()
-- at runtime (in-memory cache was reset by the code change). No SQL needed.

-- CreateTable: TenantBalance
CREATE TABLE "TenantBalance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "balanceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalDepositedMinor" INTEGER NOT NULL DEFAULT 0,
    "totalSpentMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantBalance_tenantId_key" ON "TenantBalance"("tenantId");

ALTER TABLE "TenantBalance" ADD CONSTRAINT "TenantBalance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: TenantTransaction
CREATE TABLE "TenantTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "orderId" TEXT,
    "ledgerTransactionId" TEXT,
    "description" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantTransaction_idempotencyKey_key" ON "TenantTransaction"("idempotencyKey");
CREATE INDEX "TenantTransaction_tenantId_idx" ON "TenantTransaction"("tenantId");
CREATE INDEX "TenantTransaction_type_idx" ON "TenantTransaction"("type");
CREATE INDEX "TenantTransaction_createdAt_idx" ON "TenantTransaction"("createdAt");

ALTER TABLE "TenantTransaction" ADD CONSTRAINT "TenantTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
