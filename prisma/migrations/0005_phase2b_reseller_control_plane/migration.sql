-- Phase 2B — Reseller SaaS Control Plane
-- Adds: TenantCustomer, SaaasPlan, TenantSubscription, ApiKey models
-- Extends: Session (activeTenantId), Order (tenantCustomerId, distributionOfferId),
--          AuditLog (tenantId), TenantUser (expanded roles)

-- AlterTable: Session — add activeTenantId for tenant context
ALTER TABLE "Session" ADD COLUMN "activeTenantId" TEXT;

-- AlterTable: Order — add tenantCustomerId + distributionOfferId
ALTER TABLE "Order" ADD COLUMN "tenantCustomerId" TEXT;
ALTER TABLE "Order" ADD COLUMN "distributionOfferId" TEXT;

-- AlterTable: AuditLog — add tenantId for tenant-scoped audit trail
ALTER TABLE "AuditLog" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "AuditLog_tenantId_idx" ON "AuditLog"("tenantId");

-- CreateTable: TenantCustomer
CREATE TABLE "TenantCustomer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: TenantCustomer
CREATE UNIQUE INDEX "TenantCustomer_tenantId_email_key" ON "TenantCustomer"("tenantId", "email");
CREATE INDEX "TenantCustomer_tenantId_idx" ON "TenantCustomer"("tenantId");
CREATE INDEX "TenantCustomer_userId_idx" ON "TenantCustomer"("userId");
CREATE INDEX "TenantCustomer_status_idx" ON "TenantCustomer"("status");

-- AddForeignKey: TenantCustomer -> Tenant
ALTER TABLE "TenantCustomer" ADD CONSTRAINT "TenantCustomer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: SaaasPlan
CREATE TABLE "SaaasPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "monthlyPriceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "includedStaff" INTEGER NOT NULL DEFAULT 1,
    "includedCustomers" INTEGER NOT NULL DEFAULT 10,
    "includedOrdersPerMonth" INTEGER NOT NULL DEFAULT 100,
    "platformFeePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "perOrderFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "features" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaasPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SaaasPlan_name_key" ON "SaaasPlan"("name");
CREATE INDEX "SaaasPlan_status_idx" ON "SaaasPlan"("status");

-- CreateTable: TenantSubscription
CREATE TABLE "TenantSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saaasPlanId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantSubscription_tenantId_key" ON "TenantSubscription"("tenantId");
CREATE INDEX "TenantSubscription_status_idx" ON "TenantSubscription"("status");

ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_saaasPlanId_fkey" FOREIGN KEY ("saaasPlanId") REFERENCES "SaaasPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: ApiKey
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'read',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKey_hashedKey_key" ON "ApiKey"("hashedKey");
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");
CREATE INDEX "ApiKey_hashedKey_idx" ON "ApiKey"("hashedKey");

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
