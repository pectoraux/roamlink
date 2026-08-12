/**
 * Tenant Catalog service — browse available products + manage DistributionOffers.
 *
 * Phase 2B: A reseller browses the canonical ConnectivityProduct catalog and
 * creates DistributionOffers (their retail price) for products they want to sell.
 *
 * Margin protection: the service enforces a minimum margin policy server-side.
 * A reseller cannot set a retail price below the supplier wholesale cost
 * (unless explicitly allowed by platform policy).
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";
import { createDistributionOffer, getDistributionOffers, getDistributionOfferForTenant } from "./service";

/** Minimum margin percent enforced platform-wide (retail must be >= wholesale * (1 + MIN_MARGIN/100)). */
const MIN_MARGIN_PERCENT = 0; // 0% — reseller can sell at cost but not below cost

/**
 * List all available connectivity products (the catalog the reseller can sell).
 * Includes the reseller's existing DistributionOffer if one exists.
 */
export async function listAvailableProducts(tenantId: string) {
  const products = await db.connectivityProduct.findMany({
    where: { active: true },
    include: {
      offers: {
        where: { supplier: { status: "active" } },
        include: { supplier: true },
      },
      distributionOffers: {
        where: { tenantId },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Map to a reseller-friendly view (hide supplier-confidential data)
  return products.map((p) => {
    // Find the best (lowest wholesale) offer for margin calculation
    const bestOffer = p.offers.sort((a, b) => a.wholesalePriceMinor - b.wholesalePriceMinor)[0];
    const distOffer = p.distributionOffers[0]; // one per tenant per product
    return {
      id: p.id,
      name: p.name,
      productType: p.type,
      countryCode: p.countryCode,
      region: p.region,
      dataAmount: p.dataAmountMB,
      validityDays: p.validityDays,
      status: p.active ? "active" : "inactive",
      // The reseller sees the wholesale cost ONLY for margin calculation.
      // In a production system with supplier confidentiality, this would be
      // replaced by a "recommended retail price" that hides the actual cost.
      wholesalePriceMinor: bestOffer?.wholesalePriceMinor ?? 0,
      supplierCount: p.offers.length,
      // The reseller's distribution offer (if they've enabled this product)
      distributionOffer: distOffer
        ? {
            id: distOffer.id,
            retailPrice: distOffer.retailPrice,
            status: distOffer.status,
            audience: distOffer.audience,
          }
        : null,
    };
  });
}

/**
 * Enable a product for a tenant by creating a DistributionOffer.
 * Enforces margin protection: retailPrice must be >= wholesale * (1 + MIN_MARGIN/100).
 */
export async function enableProduct(input: {
  tenantId: string;
  productId: string;
  retailPriceMinor: number;
  audience?: string;
}): Promise<{ id: string; retailPrice: number }> {
  // Verify the product exists and has an active supplier offer
  const product = await db.connectivityProduct.findUnique({
    where: { id: input.productId },
    include: {
      offers: {
        where: { supplier: { status: "active" } },
      },
    },
  });
  if (!product) {
    throw new AppError("not_found", "Product not found", 404, "This product is not available.");
  }
  if (product.offers.length === 0) {
    throw new AppError("validation", "No active supplier for this product", 400, "This product has no active supplier.");
  }

  // Margin protection
  const bestWholesale = Math.min(...product.offers.map((o) => o.wholesalePriceMinor));
  const minRetail = Math.ceil(bestWholesale * (1 + MIN_MARGIN_PERCENT / 100));
  if (input.retailPriceMinor < minRetail) {
    throw new AppError(
      "validation",
      `Retail price below minimum (${minRetail})`,
      400,
      `The retail price must be at least $${(minRetail / 100).toFixed(2)} to maintain margin policy.`,
    );
  }

  const offer = await createDistributionOffer({
    tenantId: input.tenantId,
    productId: input.productId,
    retailPriceMinor: input.retailPriceMinor,
    audience: input.audience,
  });

  await audit({
    tenantId: input.tenantId,
    action: "distribution_offer.enabled",
    entity: "distribution_offer",
    entityId: offer.id,
    detail: { productId: input.productId, retailPrice: input.retailPriceMinor },
  });
  logger.info("catalog.product_enabled", { tenantId: input.tenantId, productId: input.productId, offerId: offer.id });
  return offer;
}

/** Disable a product for a tenant (set DistributionOffer status to inactive). */
export async function disableProduct(tenantId: string, offerId: string): Promise<void> {
  // Verify ownership
  await getDistributionOfferForTenant(offerId, tenantId);
  await db.distributionOffer.update({
    where: { id: offerId },
    data: { status: "inactive" },
  });
  await audit({
    tenantId,
    action: "distribution_offer.disabled",
    entity: "distribution_offer",
    entityId: offerId,
  });
}

/** List the tenant's distribution offers (their enabled catalog). */
export async function getTenantCatalog(tenantId: string) {
  return getDistributionOffers(tenantId);
}

/**
 * Calculate the reseller economics for a distribution offer.
 * Returns retail, wholesale, gross profit, gross margin — without exposing
 * supplier-confidential data to the reseller's customers.
 */
export async function getOfferEconomics(tenantId: string, offerId: string) {
  const offer = await getDistributionOfferForTenant(offerId, tenantId);
  // Get the best wholesale price for this product
  const product = await db.connectivityProduct.findUnique({
    where: { id: offer.productId },
    include: {
      offers: {
        where: { supplier: { status: "active" } },
        select: { wholesalePriceMinor: true },
      },
    },
  });
  const wholesale = product?.offers.length ? Math.min(...product.offers.map((o) => o.wholesalePriceMinor)) : 0;
  const retail = offer.retailPrice;
  const grossProfit = retail - wholesale;
  const grossMarginPercent = retail > 0 ? (grossProfit / retail) * 100 : 0;
  return {
    retailPriceMinor: retail,
    wholesaleCostMinor: wholesale, // visible to tenant admin for margin calculation
    grossProfitMinor: grossProfit,
    grossMarginPercent: Math.round(grossMarginPercent * 100) / 100,
  };
}
