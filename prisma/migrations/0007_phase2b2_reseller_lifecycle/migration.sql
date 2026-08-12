-- Phase 2B.2 — Reseller Balance Reservation + Deposit Payment Lifecycle
-- Adds: TenantBalanceReservation, TenantDepositPayment models

-- CreateTable: TenantBalanceReservation
CREATE TABLE "TenantBalanceReservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RESERVED',
    "idempotencyKey" TEXT NOT NULL,
    "ledgerTransactionId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantBalanceReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantBalanceReservation_orderId_key" ON "TenantBalanceReservation"("orderId");
CREATE UNIQUE INDEX "TenantBalanceReservation_idempotencyKey_key" ON "TenantBalanceReservation"("idempotencyKey");
CREATE INDEX "TenantBalanceReservation_tenantId_idx" ON "TenantBalanceReservation"("tenantId");
CREATE INDEX "TenantBalanceReservation_state_idx" ON "TenantBalanceReservation"("state");

ALTER TABLE "TenantBalanceReservation" ADD CONSTRAINT "TenantBalanceReservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: TenantDepositPayment
CREATE TABLE "TenantDepositPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentProvider" TEXT NOT NULL,
    "providerReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DEPOSIT_CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "tenantTransactionId" TEXT,
    "ledgerTransactionId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantDepositPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantDepositPayment_idempotencyKey_key" ON "TenantDepositPayment"("idempotencyKey");
CREATE INDEX "TenantDepositPayment_tenantId_idx" ON "TenantDepositPayment"("tenantId");
CREATE INDEX "TenantDepositPayment_status_idx" ON "TenantDepositPayment"("status");
CREATE INDEX "TenantDepositPayment_providerReference_idx" ON "TenantDepositPayment"("providerReference");
