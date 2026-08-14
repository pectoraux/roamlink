-- CreateTable
CREATE TABLE "SubscriptionRenewalCycle" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "paidFromCreditMinor" INTEGER NOT NULL DEFAULT 0,
    "paidFromCashMinor" INTEGER NOT NULL DEFAULT 0,
    "paymentFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionRenewalCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionRenewalCycle_cycleKey_key" ON "SubscriptionRenewalCycle"("cycleKey");

-- CreateIndex
CREATE INDEX "SubscriptionRenewalCycle_subscriptionId_idx" ON "SubscriptionRenewalCycle"("subscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionRenewalCycle_state_idx" ON "SubscriptionRenewalCycle"("state");

-- CreateIndex
CREATE INDEX "SubscriptionRenewalCycle_periodStart_idx" ON "SubscriptionRenewalCycle"("periodStart");

-- AddForeignKey
ALTER TABLE "SubscriptionRenewalCycle" ADD CONSTRAINT "SubscriptionRenewalCycle_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "NumberSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

