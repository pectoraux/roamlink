-- Phase 2B.3 — SaaS Billing
-- Extends TenantSubscription with payment lifecycle fields
-- Adds TenantInvoice model for receipt records

-- AlterTable: TenantSubscription
ALTER TABLE "TenantSubscription" ADD COLUMN "paymentProvider" TEXT;
ALTER TABLE "TenantSubscription" ADD COLUMN "providerReference" TEXT;
ALTER TABLE "TenantSubscription" ADD COLUMN "renewalIdempotencyKey" TEXT;
ALTER TABLE "TenantSubscription" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "TenantSubscription" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "TenantSubscription" ADD COLUMN "trialEndsAt" TIMESTAMP(3);

-- CreateTable: TenantInvoice
CREATE TABLE "TenantInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "saaasPlanName" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billingCycle" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paymentProvider" TEXT,
    "providerReference" TEXT,
    "ledgerTransactionId" TEXT,
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantInvoice_idempotencyKey_key" ON "TenantInvoice"("idempotencyKey");
CREATE INDEX "TenantInvoice_tenantId_idx" ON "TenantInvoice"("tenantId");
CREATE INDEX "TenantInvoice_subscriptionId_idx" ON "TenantInvoice"("subscriptionId");
CREATE INDEX "TenantInvoice_status_idx" ON "TenantInvoice"("status");

ALTER TABLE "TenantInvoice" ADD CONSTRAINT "TenantInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantInvoice" ADD CONSTRAINT "TenantInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
