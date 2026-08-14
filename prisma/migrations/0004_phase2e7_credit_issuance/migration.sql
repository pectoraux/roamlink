-- CreateTable
CREATE TABLE "CreditIssuance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "creditTransactionId" TEXT,
    "ledgerTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditIssuance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditIssuance_idempotencyKey_key" ON "CreditIssuance"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditIssuance_userId_idx" ON "CreditIssuance"("userId");

-- CreateIndex
CREATE INDEX "CreditIssuance_sourceType_sourceId_idx" ON "CreditIssuance"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CreditIssuance_status_idx" ON "CreditIssuance"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_userId_orderId_type_key" ON "CreditTransaction"("userId", "orderId", "type");

