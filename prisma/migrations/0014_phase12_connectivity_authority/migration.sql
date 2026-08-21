-- AlterTable
ALTER TABLE "TenantTransaction" ALTER COLUMN "sequenceNumber" DROP DEFAULT;

-- CreateTable
CREATE TABLE "IdempotencyOperation" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "resultJson" TEXT,
    "failureJson" TEXT,
    "payloadHash" TEXT,
    "tenantId" TEXT,
    "principalId" TEXT,
    "principalType" TEXT,
    "claimId" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "providerKey" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciliationClaimId" TEXT,
    "reconciliationClaimExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityCapability" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "attributes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectivityCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityEntitlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "capabilitySet" TEXT NOT NULL,
    "policy" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "reconciliationState" TEXT,
    "failureReason" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectivityEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderResourceBinding" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "resourceType" TEXT,
    "providerResourceId" TEXT,
    "providerMetadata" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNBOUND',
    "provisioningState" TEXT,
    "reconciliationState" TEXT,
    "failureReason" TEXT,
    "lastReconciledAt" TIMESTAMP(3),
    "providerInstanceId" TEXT,
    "provisioningAttemptId" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderResourceBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityProviderInstance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "configuration" TEXT,
    "configurationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectivityProviderInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "capabilityType" TEXT NOT NULL,
    "providerType" TEXT,
    "pricingModel" TEXT NOT NULL DEFAULT 'FLAT',
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billingCycle" TEXT NOT NULL DEFAULT 'one_time',
    "capabilitySet" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResellerProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "entitlementId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentRef" TEXT,
    "credentials" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityOffer2" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "capabilityType" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "wholesalePriceMinor" INTEGER NOT NULL DEFAULT 0,
    "customerPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "supplierId" TEXT,
    "resellerProductId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "reliabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "lastProvisionedAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "capabilityId" TEXT,

    CONSTRAINT "ConnectivityOffer2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerMarkup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "capabilityType" TEXT,
    "providerType" TEXT,
    "supplierId" TEXT,
    "markupPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "markupFixedMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResellerMarkup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityIntent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT,
    "capabilityType" TEXT,
    "desiredSpec" TEXT,
    "location" TEXT,
    "maxPriceMinor" INTEGER,
    "rankedResults" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectivityIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerEarning" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerPaymentMinor" INTEGER NOT NULL,
    "wholesaleCostMinor" INTEGER NOT NULL,
    "paymentFeeMinor" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "resellerEarningMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResellerEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCost" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "offerId" TEXT,
    "supplierId" TEXT,
    "wholesaleCostMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "settledAt" TIMESTAMP(3),
    "ledgerTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerPayout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "method" TEXT NOT NULL,
    "destinationRef" TEXT,
    "ledgerTransactionId" TEXT,
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResellerPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT,
    "rawText" TEXT,
    "parsedIntent" TEXT NOT NULL,
    "rankedOfferIds" TEXT,
    "selectedOfferId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeEntitlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "entitlementId" TEXT,
    "productId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierSettlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalCostMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "providerInvoiceId" TEXT,
    "costCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferRating" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "review" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UptimeMeasurement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerInstanceId" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isReachable" BOOLEAN NOT NULL,
    "responseTimeMs" INTEGER,

    CONSTRAINT "UptimeMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivitySession" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "intentId" TEXT,
    "entitlementId" TEXT,
    "activeResourceId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PLANNED',
    "policyId" TEXT,
    "startedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "executionSlotClaimId" TEXT,
    "executionSlotClaimedAt" TIMESTAMP(3),
    "executionSlotClaimExpiresAt" TIMESTAMP(3),

    CONSTRAINT "ConnectivitySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityMeasurement" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "resourceId" TEXT,
    "providerInstanceId" TEXT,
    "type" TEXT NOT NULL,
    "metrics" TEXT NOT NULL,
    "freshness" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT NOT NULL DEFAULT 'PROVIDER',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deduplicationKey" TEXT,
    "trust" TEXT NOT NULL DEFAULT 'TRUSTED',
    "integrity" TEXT NOT NULL DEFAULT 'VALID',

    CONSTRAINT "ConnectivityMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityPolicy" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'manual',
    "maxAutoSpendMinor" INTEGER NOT NULL DEFAULT 0,
    "preferredTransports" TEXT,
    "minReliability" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "switchHysteresis" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "requireUserApprovalForPurchase" BOOLEAN NOT NULL DEFAULT true,
    "neverInterruptActiveCall" BOOLEAN NOT NULL DEFAULT true,
    "preset" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectivityPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityDecision" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "intentVersion" INTEGER,
    "sessionId" TEXT,
    "action" TEXT NOT NULL,
    "targetResourceId" TEXT,
    "targetOfferId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "constraintsSatisfied" TEXT,
    "constraintsViolated" TEXT,
    "reasons" TEXT,
    "reasonCodes" TEXT,
    "policyVersion" TEXT,
    "basePolicyId" TEXT,
    "basePolicyVersion" INTEGER,
    "basePreset" TEXT,
    "contextDeviceId" TEXT,
    "contextVersion" INTEGER,
    "contextObservedAt" TIMESTAMP(3),
    "effectivePreset" TEXT,
    "derivationReasons" TEXT,
    "executionState" TEXT NOT NULL DEFAULT 'PENDING',
    "executionClaimId" TEXT,
    "executionClaimedAt" TIMESTAMP(3),
    "executionClaimExpiresAt" TIMESTAMP(3),
    "executionAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "executedAt" TIMESTAMP(3),
    "executedActionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectivityDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityAction" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "decisionId" TEXT,
    "type" TEXT NOT NULL,
    "targetResourceId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PLANNED',
    "reason" TEXT,
    "policyVersion" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "kernelExecutionId" TEXT,
    "recoveryClaimId" TEXT,
    "recoveryClaimedAt" TIMESTAMP(3),
    "recoveryClaimExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "ConnectivityAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolCapability" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerInstanceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "technicalSpec" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "reliability" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" TEXT NOT NULL DEFAULT 'active',
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtocolCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolResource" (
    "id" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "providerInstanceId" TEXT NOT NULL,
    "identifiers" TEXT,
    "state" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "capacity" TEXT,
    "location" TEXT,
    "reservedAt" TIMESTAMP(3),
    "reservedBy" TEXT,
    "providerBindingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtocolResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceHealth" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "quality" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "degradedCount" INTEGER NOT NULL DEFAULT 0,
    "freshness" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "derivedFromSources" TEXT,
    "latestMeasurementId" TEXT,
    "trust" TEXT NOT NULL DEFAULT 'UNTRUSTED',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReevaluationEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "resourceId" TEXT,
    "sessionId" TEXT,
    "subjectId" TEXT,
    "payload" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "claimId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReevaluationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeDevice" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "policyContext" TEXT,
    "policyContextUpdatedAt" TIMESTAMP(3),
    "policyContextVersion" INTEGER NOT NULL DEFAULT 0,
    "policyContextObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EdgeDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeObservationRecord" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "resourceId" TEXT,
    "sequence" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "payload" TEXT NOT NULL,
    "derivedMeasurementId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EdgeObservationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityIntentRecord" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "deviceId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "supersedesIntentId" TEXT,
    "supersedesVersion" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "source" TEXT NOT NULL DEFAULT 'USER',
    "idempotencyKey" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "fenceVersion" INTEGER NOT NULL DEFAULT 0,
    "executionFenceId" TEXT,
    "executionFenceExpiresAt" TIMESTAMP(3),
    "sourceRequestId" TEXT,
    "sourceChannel" TEXT,
    "tenantId" TEXT,

    CONSTRAINT "ConnectivityIntentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderOperationRecord" (
    "id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'STARTED',
    "outcome" TEXT,
    "outcomeDetail" TEXT,
    "providerResourceId" TEXT,
    "bindingId" TEXT,
    "providerInstanceId" TEXT,
    "providerType" TEXT,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT,
    "intentId" TEXT,
    "decisionId" TEXT,
    "actionId" TEXT,
    "sessionId" TEXT,
    "providerKey" TEXT,
    "reconciliationState" TEXT,
    "recoveryClaimId" TEXT,
    "recoveryClaimedAt" TIMESTAMP(3),
    "recoveryClaimExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderOperationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdempotencyOperation_state_idx" ON "IdempotencyOperation"("state");

-- CreateIndex
CREATE INDEX "IdempotencyOperation_claimExpiresAt_idx" ON "IdempotencyOperation"("claimExpiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyOperation_tenantId_idx" ON "IdempotencyOperation"("tenantId");

-- CreateIndex
CREATE INDEX "IdempotencyOperation_claimId_idx" ON "IdempotencyOperation"("claimId");

-- CreateIndex
CREATE INDEX "IdempotencyOperation_providerKey_idx" ON "IdempotencyOperation"("providerKey");

-- CreateIndex
CREATE INDEX "IdempotencyOperation_reconciledAt_idx" ON "IdempotencyOperation"("reconciledAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyOperation_scope_key_key" ON "IdempotencyOperation"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectivityCapability_type_key" ON "ConnectivityCapability"("type");

-- CreateIndex
CREATE INDEX "ConnectivityEntitlement_tenantId_idx" ON "ConnectivityEntitlement"("tenantId");

-- CreateIndex
CREATE INDEX "ConnectivityEntitlement_subscriptionId_idx" ON "ConnectivityEntitlement"("subscriptionId");

-- CreateIndex
CREATE INDEX "ConnectivityEntitlement_status_idx" ON "ConnectivityEntitlement"("status");

-- CreateIndex
CREATE INDEX "ConnectivityEntitlement_capabilityId_idx" ON "ConnectivityEntitlement"("capabilityId");

-- CreateIndex
CREATE INDEX "ConnectivityEntitlement_userId_idx" ON "ConnectivityEntitlement"("userId");

-- CreateIndex
CREATE INDEX "ProviderResourceBinding_entitlementId_idx" ON "ProviderResourceBinding"("entitlementId");

-- CreateIndex
CREATE INDEX "ProviderResourceBinding_providerType_idx" ON "ProviderResourceBinding"("providerType");

-- CreateIndex
CREATE INDEX "ProviderResourceBinding_status_idx" ON "ProviderResourceBinding"("status");

-- CreateIndex
CREATE INDEX "ProviderResourceBinding_providerInstanceId_idx" ON "ProviderResourceBinding"("providerInstanceId");

-- CreateIndex
CREATE INDEX "ConnectivityProviderInstance_tenantId_idx" ON "ConnectivityProviderInstance"("tenantId");

-- CreateIndex
CREATE INDEX "ConnectivityProviderInstance_providerType_idx" ON "ConnectivityProviderInstance"("providerType");

-- CreateIndex
CREATE INDEX "ConnectivityProviderInstance_status_idx" ON "ConnectivityProviderInstance"("status");

-- CreateIndex
CREATE INDEX "ResellerProduct_tenantId_idx" ON "ResellerProduct"("tenantId");

-- CreateIndex
CREATE INDEX "ResellerProduct_capabilityType_idx" ON "ResellerProduct"("capabilityType");

-- CreateIndex
CREATE INDEX "ResellerProduct_providerType_idx" ON "ResellerProduct"("providerType");

-- CreateIndex
CREATE INDEX "ResellerProduct_status_idx" ON "ResellerProduct"("status");

-- CreateIndex
CREATE INDEX "CustomerOrder_tenantId_idx" ON "CustomerOrder"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerOrder_customerId_idx" ON "CustomerOrder"("customerId");

-- CreateIndex
CREATE INDEX "CustomerOrder_productId_idx" ON "CustomerOrder"("productId");

-- CreateIndex
CREATE INDEX "CustomerOrder_status_idx" ON "CustomerOrder"("status");

-- CreateIndex
CREATE INDEX "ConnectivityOffer2_tenantId_idx" ON "ConnectivityOffer2"("tenantId");

-- CreateIndex
CREATE INDEX "ConnectivityOffer2_capabilityType_idx" ON "ConnectivityOffer2"("capabilityType");

-- CreateIndex
CREATE INDEX "ConnectivityOffer2_providerType_idx" ON "ConnectivityOffer2"("providerType");

-- CreateIndex
CREATE INDEX "ConnectivityOffer2_supplierId_idx" ON "ConnectivityOffer2"("supplierId");

-- CreateIndex
CREATE INDEX "ConnectivityOffer2_status_idx" ON "ConnectivityOffer2"("status");

-- CreateIndex
CREATE INDEX "ConnectivityOffer2_capabilityId_idx" ON "ConnectivityOffer2"("capabilityId");

-- CreateIndex
CREATE INDEX "ResellerMarkup_tenantId_idx" ON "ResellerMarkup"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ResellerMarkup_tenantId_capabilityType_providerType_supplie_key" ON "ResellerMarkup"("tenantId", "capabilityType", "providerType", "supplierId");

-- CreateIndex
CREATE INDEX "ConnectivityIntent_tenantId_idx" ON "ConnectivityIntent"("tenantId");

-- CreateIndex
CREATE INDEX "ConnectivityIntent_customerId_idx" ON "ConnectivityIntent"("customerId");

-- CreateIndex
CREATE INDEX "ResellerEarning_tenantId_idx" ON "ResellerEarning"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ResellerEarning_orderId_key" ON "ResellerEarning"("orderId");

-- CreateIndex
CREATE INDEX "ProviderCost_tenantId_idx" ON "ProviderCost"("tenantId");

-- CreateIndex
CREATE INDEX "ProviderCost_orderId_idx" ON "ProviderCost"("orderId");

-- CreateIndex
CREATE INDEX "ProviderCost_supplierId_idx" ON "ProviderCost"("supplierId");

-- CreateIndex
CREATE INDEX "ResellerPayout_tenantId_idx" ON "ResellerPayout"("tenantId");

-- CreateIndex
CREATE INDEX "ResellerPayout_status_idx" ON "ResellerPayout"("status");

-- CreateIndex
CREATE INDEX "IntentRequest_tenantId_idx" ON "IntentRequest"("tenantId");

-- CreateIndex
CREATE INDEX "IntentRequest_status_idx" ON "IntentRequest"("status");

-- CreateIndex
CREATE INDEX "EmployeeEntitlement_organizationId_idx" ON "EmployeeEntitlement"("organizationId");

-- CreateIndex
CREATE INDEX "EmployeeEntitlement_memberId_idx" ON "EmployeeEntitlement"("memberId");

-- CreateIndex
CREATE INDEX "SupplierSettlement_tenantId_supplierId_idx" ON "SupplierSettlement"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "SupplierSettlement_status_idx" ON "SupplierSettlement"("status");

-- CreateIndex
CREATE INDEX "OfferRating_offerId_idx" ON "OfferRating"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferRating_orderId_key" ON "OfferRating"("orderId");

-- CreateIndex
CREATE INDEX "UptimeMeasurement_tenantId_providerInstanceId_idx" ON "UptimeMeasurement"("tenantId", "providerInstanceId");

-- CreateIndex
CREATE INDEX "UptimeMeasurement_measuredAt_idx" ON "UptimeMeasurement"("measuredAt");

-- CreateIndex
CREATE INDEX "ConnectivitySession_subjectId_idx" ON "ConnectivitySession"("subjectId");

-- CreateIndex
CREATE INDEX "ConnectivitySession_state_idx" ON "ConnectivitySession"("state");

-- CreateIndex
CREATE INDEX "ConnectivitySession_entitlementId_idx" ON "ConnectivitySession"("entitlementId");

-- CreateIndex
CREATE INDEX "ConnectivitySession_executionSlotClaimExpiresAt_idx" ON "ConnectivitySession"("executionSlotClaimExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectivityMeasurement_deduplicationKey_key" ON "ConnectivityMeasurement"("deduplicationKey");

-- CreateIndex
CREATE INDEX "ConnectivityMeasurement_sessionId_idx" ON "ConnectivityMeasurement"("sessionId");

-- CreateIndex
CREATE INDEX "ConnectivityMeasurement_resourceId_idx" ON "ConnectivityMeasurement"("resourceId");

-- CreateIndex
CREATE INDEX "ConnectivityMeasurement_capturedAt_idx" ON "ConnectivityMeasurement"("capturedAt");

-- CreateIndex
CREATE INDEX "ConnectivityMeasurement_source_idx" ON "ConnectivityMeasurement"("source");

-- CreateIndex
CREATE INDEX "ConnectivityMeasurement_freshness_idx" ON "ConnectivityMeasurement"("freshness");

-- CreateIndex
CREATE INDEX "ConnectivityMeasurement_trust_idx" ON "ConnectivityMeasurement"("trust");

-- CreateIndex
CREATE INDEX "ConnectivityMeasurement_integrity_idx" ON "ConnectivityMeasurement"("integrity");

-- CreateIndex
CREATE INDEX "ConnectivityPolicy_subjectId_idx" ON "ConnectivityPolicy"("subjectId");

-- CreateIndex
CREATE INDEX "ConnectivityDecision_intentId_idx" ON "ConnectivityDecision"("intentId");

-- CreateIndex
CREATE INDEX "ConnectivityDecision_sessionId_idx" ON "ConnectivityDecision"("sessionId");

-- CreateIndex
CREATE INDEX "ConnectivityDecision_executionState_idx" ON "ConnectivityDecision"("executionState");

-- CreateIndex
CREATE INDEX "ConnectivityDecision_executionClaimExpiresAt_idx" ON "ConnectivityDecision"("executionClaimExpiresAt");

-- CreateIndex
CREATE INDEX "ConnectivityDecision_basePolicyId_idx" ON "ConnectivityDecision"("basePolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectivityAction_idempotencyKey_key" ON "ConnectivityAction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ConnectivityAction_sessionId_idx" ON "ConnectivityAction"("sessionId");

-- CreateIndex
CREATE INDEX "ConnectivityAction_decisionId_idx" ON "ConnectivityAction"("decisionId");

-- CreateIndex
CREATE INDEX "ConnectivityAction_state_idx" ON "ConnectivityAction"("state");

-- CreateIndex
CREATE INDEX "ConnectivityAction_recoveryClaimId_idx" ON "ConnectivityAction"("recoveryClaimId");

-- CreateIndex
CREATE INDEX "ProtocolCapability_tenantId_idx" ON "ProtocolCapability"("tenantId");

-- CreateIndex
CREATE INDEX "ProtocolCapability_providerInstanceId_idx" ON "ProtocolCapability"("providerInstanceId");

-- CreateIndex
CREATE INDEX "ProtocolCapability_type_idx" ON "ProtocolCapability"("type");

-- CreateIndex
CREATE INDEX "ProtocolCapability_status_idx" ON "ProtocolCapability"("status");

-- CreateIndex
CREATE INDEX "ProtocolResource_capabilityId_idx" ON "ProtocolResource"("capabilityId");

-- CreateIndex
CREATE INDEX "ProtocolResource_providerInstanceId_idx" ON "ProtocolResource"("providerInstanceId");

-- CreateIndex
CREATE INDEX "ProtocolResource_state_idx" ON "ProtocolResource"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceHealth_resourceId_key" ON "ResourceHealth"("resourceId");

-- CreateIndex
CREATE INDEX "ResourceHealth_status_idx" ON "ResourceHealth"("status");

-- CreateIndex
CREATE INDEX "ResourceHealth_sessionId_idx" ON "ResourceHealth"("sessionId");

-- CreateIndex
CREATE INDEX "ResourceHealth_trust_idx" ON "ResourceHealth"("trust");

-- CreateIndex
CREATE UNIQUE INDEX "ReevaluationEvent_idempotencyKey_key" ON "ReevaluationEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReevaluationEvent_processedAt_idx" ON "ReevaluationEvent"("processedAt");

-- CreateIndex
CREATE INDEX "ReevaluationEvent_state_idx" ON "ReevaluationEvent"("state");

-- CreateIndex
CREATE INDEX "ReevaluationEvent_type_idx" ON "ReevaluationEvent"("type");

-- CreateIndex
CREATE INDEX "ReevaluationEvent_resourceId_idx" ON "ReevaluationEvent"("resourceId");

-- CreateIndex
CREATE INDEX "ReevaluationEvent_sessionId_idx" ON "ReevaluationEvent"("sessionId");

-- CreateIndex
CREATE INDEX "ReevaluationEvent_claimExpiresAt_idx" ON "ReevaluationEvent"("claimExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeDevice_deviceId_key" ON "EdgeDevice"("deviceId");

-- CreateIndex
CREATE INDEX "EdgeDevice_userId_idx" ON "EdgeDevice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeObservationRecord_observationId_key" ON "EdgeObservationRecord"("observationId");

-- CreateIndex
CREATE INDEX "EdgeObservationRecord_deviceId_idx" ON "EdgeObservationRecord"("deviceId");

-- CreateIndex
CREATE INDEX "EdgeObservationRecord_userId_idx" ON "EdgeObservationRecord"("userId");

-- CreateIndex
CREATE INDEX "EdgeObservationRecord_sessionId_idx" ON "EdgeObservationRecord"("sessionId");

-- CreateIndex
CREATE INDEX "EdgeObservationRecord_resourceId_idx" ON "EdgeObservationRecord"("resourceId");

-- CreateIndex
CREATE INDEX "EdgeObservationRecord_observedAt_idx" ON "EdgeObservationRecord"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeObservationRecord_deviceId_sequence_key" ON "EdgeObservationRecord"("deviceId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectivityIntentRecord_idempotencyKey_key" ON "ConnectivityIntentRecord"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ConnectivityIntentRecord_subjectId_idx" ON "ConnectivityIntentRecord"("subjectId");

-- CreateIndex
CREATE INDEX "ConnectivityIntentRecord_intentId_idx" ON "ConnectivityIntentRecord"("intentId");

-- CreateIndex
CREATE INDEX "ConnectivityIntentRecord_status_idx" ON "ConnectivityIntentRecord"("status");

-- CreateIndex
CREATE INDEX "ConnectivityIntentRecord_expiresAt_idx" ON "ConnectivityIntentRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "ConnectivityIntentRecord_sourceRequestId_idx" ON "ConnectivityIntentRecord"("sourceRequestId");

-- CreateIndex
CREATE INDEX "ConnectivityIntentRecord_tenantId_idx" ON "ConnectivityIntentRecord"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectivityIntentRecord_intentId_version_key" ON "ConnectivityIntentRecord"("intentId", "version");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_tenantId_idx" ON "ProviderOperationRecord"("tenantId");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_state_idx" ON "ProviderOperationRecord"("state");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_requestId_idx" ON "ProviderOperationRecord"("requestId");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_actionId_idx" ON "ProviderOperationRecord"("actionId");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_providerInstanceId_idx" ON "ProviderOperationRecord"("providerInstanceId");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_providerResourceId_idx" ON "ProviderOperationRecord"("providerResourceId");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_bindingId_idx" ON "ProviderOperationRecord"("bindingId");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_providerKey_idx" ON "ProviderOperationRecord"("providerKey");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_startedAt_idx" ON "ProviderOperationRecord"("startedAt");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_recoveryClaimId_idx" ON "ProviderOperationRecord"("recoveryClaimId");

-- CreateIndex
CREATE INDEX "ProviderOperationRecord_recoveryClaimExpiresAt_idx" ON "ProviderOperationRecord"("recoveryClaimExpiresAt");

-- CreateIndex
CREATE INDEX "RateLimitEvent_scope_scopeId_createdAt_idx" ON "RateLimitEvent"("scope", "scopeId", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimitEvent_createdAt_idx" ON "RateLimitEvent"("createdAt");

-- CreateIndex
CREATE INDEX "RateLimitCounter_expiresAt_idx" ON "RateLimitCounter"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitCounter_scope_scopeId_windowKey_key" ON "RateLimitCounter"("scope", "scopeId", "windowKey");

-- CreateIndex
CREATE INDEX "TenantBalanceReservation_orderId_idx" ON "TenantBalanceReservation"("orderId");

-- AddForeignKey
ALTER TABLE "TenantDepositPayment" ADD CONSTRAINT "TenantDepositPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityEntitlement" ADD CONSTRAINT "ConnectivityEntitlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityEntitlement" ADD CONSTRAINT "ConnectivityEntitlement_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "ConnectivityCapability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderResourceBinding" ADD CONSTRAINT "ProviderResourceBinding_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "ConnectivityEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderResourceBinding" ADD CONSTRAINT "ProviderResourceBinding_providerInstanceId_fkey" FOREIGN KEY ("providerInstanceId") REFERENCES "ConnectivityProviderInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityProviderInstance" ADD CONSTRAINT "ConnectivityProviderInstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerProduct" ADD CONSTRAINT "ResellerProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOrder" ADD CONSTRAINT "CustomerOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOrder" ADD CONSTRAINT "CustomerOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOrder" ADD CONSTRAINT "CustomerOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ResellerProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityOffer2" ADD CONSTRAINT "ConnectivityOffer2_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityOffer2" ADD CONSTRAINT "ConnectivityOffer2_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "ProtocolCapability"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerMarkup" ADD CONSTRAINT "ResellerMarkup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityIntent" ADD CONSTRAINT "ConnectivityIntent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerEarning" ADD CONSTRAINT "ResellerEarning_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCost" ADD CONSTRAINT "ProviderCost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerPayout" ADD CONSTRAINT "ResellerPayout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentRequest" ADD CONSTRAINT "IntentRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeEntitlement" ADD CONSTRAINT "EmployeeEntitlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierSettlement" ADD CONSTRAINT "SupplierSettlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferRating" ADD CONSTRAINT "OfferRating_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UptimeMeasurement" ADD CONSTRAINT "UptimeMeasurement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivitySession" ADD CONSTRAINT "ConnectivitySession_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ConnectivityPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivitySession" ADD CONSTRAINT "ConnectivitySession_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "ConnectivityEntitlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityMeasurement" ADD CONSTRAINT "ConnectivityMeasurement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConnectivitySession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityDecision" ADD CONSTRAINT "ConnectivityDecision_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConnectivitySession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityAction" ADD CONSTRAINT "ConnectivityAction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConnectivitySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityAction" ADD CONSTRAINT "ConnectivityAction_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ConnectivityDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtocolResource" ADD CONSTRAINT "ProtocolResource_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "ProtocolCapability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EdgeObservationRecord" ADD CONSTRAINT "EdgeObservationRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "EdgeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

