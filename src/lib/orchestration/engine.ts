/**
 * Orchestration Engine — selects the best supplier offer for a canonical
 * connectivity product at fulfillment time.
 *
 * THE ORCHESTRATOR IS THE BRIDGE BETWEEN THE TENANT'S FROZEN RETAIL PRICE
 * (DistributionOffer) AND THE ACTUAL SUPPLIER THAT WILL FULFILL THE ORDER.
 *
 * Selection algorithm (deterministic):
 *   1. Fetch all active ConnectivityOffers for the product.
 *   2. Filter by redistribution policy vs. the requested audience.
 *   3. Filter out suppliers in cooldown or marked unhealthy.
 *   4. Filter out suppliers with insufficient provider credit.
 *   5. Score each remaining offer:
 *        score = reliability * 1000 - wholesalePrice
 *      where reliability = successCount / (successCount + failureCount + 1)
 *   6. Return the highest-scoring offer. Ties broken by lower wholesalePrice,
 *      then by earlier createdAt.
 *
 * The engine NEVER reads the tenant's DistributionOffer.retailPrice — the
 * supplier must never determine the tenant's retail price.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { canProviderCommit } from "@/lib/finance/provider-credit";

export type OrchestrationPreferences = {
  audience?: "B2C" | "B2B"; // default B2C
};

export type SelectedSupplierOffer = {
  offerId: string;
  productId: string;
  supplierId: string;
  supplierName: string;
  providerKey: string | null;
  wholesalePrice: number;
  retailPrice: number;
  currency: string;
  reliability: number;
  score: number;
  reason: string;
};

export type SupplierComparisonRow = {
  offerId: string;
  supplierId: string;
  supplierName: string;
  providerKey: string | null;
  wholesalePrice: number;
  retailPrice: number;
  currency: string;
  healthStatus: string;
  reliability: number;
  score: number;
  eligible: boolean;
  reason: string;
};

/**
 * Select the best supplier offer for a canonical product. Throws if no
 * eligible supplier is available.
 */
export async function selectSupplierForProduct(
  productId: string,
  preferences: OrchestrationPreferences = {},
): Promise<SelectedSupplierOffer> {
  const audience = preferences.audience ?? "B2C";

  const offers = await db.connectivityOffer.findMany({
    where: {
      productId,
      status: "active",
    },
    include: {
      supplier: true,
      product: true,
    },
  });

  if (offers.length === 0) {
    throw new AppError(
      "not_found",
      `No active supplier offers for product ${productId}`,
      404,
      "This product is currently unavailable.",
    );
  }

  const scored: Array<SelectedSupplierOffer & { _sortKey: number }> = [];

  for (const offer of offers) {
    const supplier = offer.supplier;
    const eligibility = await assessEligibility(supplier, offer, audience);
    if (!eligibility.eligible) {
      logger.info("orchestration.skip_offer", {
        offerId: offer.id,
        supplierId: supplier.id,
        reason: eligibility.reason,
      });
      continue;
    }

    const reliability = computeReliability(supplier.successCount, supplier.failureCount);
    const score = computeScore(reliability, offer.wholesalePrice);

    scored.push({
      offerId: offer.id,
      productId: offer.productId,
      supplierId: supplier.id,
      supplierName: supplier.name,
      providerKey: supplier.providerKey,
      wholesalePrice: offer.wholesalePrice,
      retailPrice: offer.retailPrice,
      currency: offer.currency,
      reliability,
      score,
      reason: `Selected via reliability*1000 - wholesalePrice (reliability=${reliability.toFixed(3)}, wholesale=${offer.wholesalePrice})`,
      _sortKey: score,
    });
  }

  if (scored.length === 0) {
    throw new AppError(
      "conflict",
      `No eligible supplier for product ${productId} (all filtered by health/credit/policy)`,
      409,
      "No supplier is currently available to fulfill this order. Please try again later.",
    );
  }

  // Highest score first; ties broken by lower wholesalePrice, then earlier createdAt.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.wholesalePrice !== b.wholesalePrice) return a.wholesalePrice - b.wholesalePrice;
    return 0;
  });

  const best = scored[0];
  logger.info("orchestration.selected", {
    productId,
    offerId: best.offerId,
    supplierId: best.supplierId,
    score: best.score,
  });

  // Strip the internal sort key before returning.
  const { _sortKey, ...result } = best;
  void _sortKey;
  return result;
}

/**
 * Return ALL supplier offers for a product (with eligibility + score), for
 * admin dashboards. Does NOT perform a selection.
 */
export async function getSupplierComparison(productId: string): Promise<SupplierComparisonRow[]> {
  const audience = "B2C";
  const offers = await db.connectivityOffer.findMany({
    where: { productId, status: "active" },
    include: { supplier: true },
    orderBy: { wholesalePrice: "asc" },
  });

  const rows: SupplierComparisonRow[] = [];
  for (const offer of offers) {
    const supplier = offer.supplier;
    const eligibility = await assessEligibility(supplier, offer, audience);
    const reliability = computeReliability(supplier.successCount, supplier.failureCount);
    const score = eligibility.eligible
      ? computeScore(reliability, offer.wholesalePrice)
      : 0;
    rows.push({
      offerId: offer.id,
      supplierId: supplier.id,
      supplierName: supplier.name,
      providerKey: supplier.providerKey,
      wholesalePrice: offer.wholesalePrice,
      retailPrice: offer.retailPrice,
      currency: offer.currency,
      healthStatus: supplier.healthStatus,
      reliability,
      score,
      eligible: eligibility.eligible,
      reason: eligibility.reason,
    });
  }

  // Sort: eligible first (by score desc), then ineligible.
  rows.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function assessEligibility(
  supplier: {
    id: string;
    name: string;
    providerKey: string | null;
    redistributionPolicy: string;
    healthStatus: string;
    failureCount: number;
    successCount: number;
    cooldownUntil: Date | null;
    active: boolean;
  },
  offer: { audiences: string; wholesalePrice: number; currency: string },
  audience: "B2C" | "B2B",
): Promise<{ eligible: boolean; reason: string }> {
  if (!supplier.active) {
    return { eligible: false, reason: "Supplier is inactive" };
  }
  if (supplier.healthStatus !== "healthy") {
    return { eligible: false, reason: `Supplier health=${supplier.healthStatus}` };
  }
  if (supplier.cooldownUntil && supplier.cooldownUntil.getTime() > Date.now()) {
    return { eligible: false, reason: "Supplier is in cooldown" };
  }

  // Redistribution policy check.
  // B2C_ONLY suppliers can serve B2C audiences only.
  // B2B_ONLY suppliers can serve B2B audiences only.
  // B2C_AND_B2B suppliers can serve either.
  const policy = supplier.redistributionPolicy.toUpperCase();
  if (audience === "B2C" && policy === "B2B_ONLY") {
    return { eligible: false, reason: "Supplier is B2B_ONLY" };
  }
  if (audience === "B2B" && policy === "B2C_ONLY") {
    return { eligible: false, reason: "Supplier is B2C_ONLY" };
  }

  // Offer-level audience check.
  const offerAudiences = offer.audiences.toUpperCase();
  if (audience === "B2C" && !offerAudiences.includes("B2C")) {
    return { eligible: false, reason: "Offer not available for B2C" };
  }
  if (audience === "B2B" && !offerAudiences.includes("B2B")) {
    return { eligible: false, reason: "Offer not available for B2B" };
  }

  // Provider credit check (if the supplier has a providerKey backed by an
  // account in ProviderCreditAccount).
  if (supplier.providerKey) {
    const commit = await canProviderCommit(supplier.providerKey, offer.wholesalePrice);
    if (!commit.canCommit) {
      return { eligible: false, reason: commit.reason ?? "Insufficient provider credit" };
    }
  }

  return { eligible: true, reason: "Eligible" };
}

function computeReliability(successCount: number, failureCount: number): number {
  const total = successCount + failureCount;
  if (total === 0) return 0.5; // unknown — neutral
  return successCount / total;
}

function computeScore(reliability: number, wholesalePrice: number): number {
  return Math.round(reliability * 1000) - wholesalePrice;
}
