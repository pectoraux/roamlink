-- Phase 2B.3.4 — Final SaaS billing state + billing-record integrity

-- AlterTable: TenantInvoice — make periodStart/periodEnd nullable
ALTER TABLE "TenantInvoice" ALTER COLUMN "periodStart" DROP NOT NULL;
ALTER TABLE "TenantInvoice" ALTER COLUMN "periodEnd" DROP NOT NULL;

-- CreateTable: SaasRenewalCycle
CREATE TABLE "SaasRenewalCycle" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "invoiceId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaasRenewalCycle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SaasRenewalCycle_cycleKey_key" ON "SaasRenewalCycle"("cycleKey");
CREATE INDEX "SaasRenewalCycle_subscriptionId_idx" ON "SaasRenewalCycle"("subscriptionId");
CREATE INDEX "SaasRenewalCycle_tenantId_idx" ON "SaasRenewalCycle"("tenantId");
CREATE INDEX "SaasRenewalCycle_state_idx" ON "SaasRenewalCycle"("state");
