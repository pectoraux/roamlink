/**
 * Tenant Catalog service — browse available products + manage DistributionOffers.
 *
 * Phase 2B.1: Supplier wholesale prices are NEVER exposed to tenants.
 * The tenant sees only:
 *   - recommendedRetailPriceMinor (platform-suggested retail)
 *   - minimumRetailPriceMinor (enforced floor, derived from wholesale + margin policy)
 *   - expectedProfitMinor (if they set their retail price)
 *   - expectedMarginPercent
 *
 * The actual wholesale cost is used server-side for margin enforcement but
 * never returned to the browser. This protects supplier (Airalo) confidential
 * commercial terms.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";
import { createDistributionOffer, getDistributionOffers, getDistributionOfferForTenant } from "./service";

/**
 * Minimum margin percent enforced platform-wide.
 * The minimum retail price = ceil(wholesale * (1 + MIN_MARGIN_PERCENT / 100)).
 * The tenant never sees the wholesale price — only the derived minimum.
 */
const MIN_MARGIN_PERCENT = 10; // 10% minimum margin

/**
 * Recommended retail markup percent (applied to wholesale to suggest a retail price).
 * The tenant sees this as a suggestion, not a requirement.
 */
const RECOMMENDED_MARKUP_PERCENT = 40; // 40% markup = suggested retail

/**
 * List all available connectivity products (the catalog the reseller can sell).
 * Includes the reseller's existing DistributionOffer if one exists.
 *
 * Phase 2B.1: Does NOT return wholesale prices. Returns recommended + minimum
 * retail prices derived server-side.
 */
export async function listAvailableProducts(tenantId: string) {
  const products = await db.connectivityProduct.findMany({
    where: { active: true },
    include: {
      offers: {
        where: { supplier: { active: true } },
      },
      distributionOffers: {
        where: { tenantId },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return products.map((p) => {
    // Find the best (lowest wholesale) offer for price calculation (server-side only)
    const bestOffer = p.offers.sort((a, b) => a.wholesalePrice - b.wholesalePrice)[0];
    const wholesale = bestOffer?.wholesalePrice ?? 0;

    // Derive tenant-safe pricing (wholesale never leaves the server)
    const minimumRetailPriceMinor = Math.ceil(wholesale * (1 + MIN_MARGIN_PERCENT / 100));
    const recommendedRetailPriceMinor = Math.ceil(wholesale * (1 + RECOMMENDED_MARKUP_PERCENT / 100));

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
      // Tenant-safe pricing — NO wholesale cost exposed
      recommendedRetailPriceMinor,
      minimumRetailPriceMinor,
      supplierCount: p.offers.length, // count is safe; identities are not
      // The reseller's distribution offer (if they've enabled this product)
      distributionOffer: distOffer
        ? {
            id: distOffer.id,
            retailPrice: distOffer.retailPrice,
            status: distOffer.status,
            audience: distOffer.audience,
            // Expected profit/margin (calculated server-side, no wholesale leak)
            expectedProfitMinor: distOffer.retailPrice - wholesale,
            expectedMarginPercent: distOffer.retailPrice > 0
              ? Math.round(((distOffer.retailPrice - wholesale) / distOffer.retailPrice) * 10000) / 100
              : 0,
          }
        : null,
    };
  });
}

/**
 * Enable a product for a tenant by creating a DistributionOffer.
 * Enforces margin protection: retailPrice must be >= minimumRetailPriceMinor.
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
        where: { supplier: { active: true } },
      },
    },
  });
  if (!product) {
    throw new AppError("not_found", "Product not found", 404, "This product is not available.");
  }
  if (product.offers.length === 0) {
    throw new AppError("validation", "No active supplier for this product", 400, "This product has no active supplier.");
  }

  // Margin protection (server-side, using wholesale — never exposed)
  const bestWholesale = Math.min(...product.offers.map((o) => o.wholesalePrice));
  const minRetail = Math.ceil(bestWholesale * (1 + MIN_MARGIN_PERCENT / 100));
  if (input.retailPriceMinor < minRetail) {
    throw new AppError(
      "validation",
      `Retail price below minimum`,
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
 *
 * Phase 2B.1: Returns tenant-safe economics. The wholesale cost is used
 * server-side to calculate profit/margin but is NOT returned.
 */
export async function getOfferEconomics(tenantId: string, offerId: string) {
  const offer = await getDistributionOfferForTenant(offerId, tenantId);
  // Get the best wholesale price for this product (server-side only)
  const product = await db.connectivityProduct.findUnique({
    where: { id: offer.productId },
    include: {
      offers: {
        where: { supplier: { active: true } },
        select: { wholesalePrice: true },
      },
    },
  });
  const wholesale = product?.offers.length ? Math.min(...product.offers.map((o) => o.wholesalePrice)) : 0;
  const retail = offer.retailPrice;
  const grossProfit = retail - wholesale;
  const grossMarginPercent = retail > 0 ? (grossProfit / retail) * 100 : 0;
  return {
    retailPriceMinor: retail,
    // NO wholesaleCostMinor — supplier confidentiality enforced
    minimumRetailPriceMinor: Math.ceil(wholesale * (1 + MIN_MARGIN_PERCENT / 100)),
    grossProfitMinor: grossProfit,
    grossMarginPercent: Math.round(grossMarginPercent * 100) / 100,
  };
}
