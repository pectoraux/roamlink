/**
 * Tenant service — multi-tenant authorization for the connectivity catalog.
 *
 * A Tenant is a reseller/partner that has their own DistributionOffer
 * (their retail price) for canonical connectivity products. Orders placed
 * under a tenant are isolated: a tenant can only read/modify their own
 * DistributionOffers and Orders.
 *
 *   Tenant A → DistributionOffer (product P, $X)
 *   Tenant B → DistributionOffer (product P, $Y)
 *   Same canonical product P — different retail prices.
 *
 * `tenantId = null` represents "RoamLink Direct" (the platform's own
 * distribution channel).
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Tenant CRUD
// ---------------------------------------------------------------------------

/** Create a new tenant. */
export async function createTenant(input: {
  name: string;
  slug?: string;
  brandName?: string;
  brandColor?: string;
  billingEmail?: string;
  monthlySpendLimit?: number;
  defaultMarkupPercent?: number;
}): Promise<{ id: string; name: string; slug: string; apiKey: string }> {
  const slug = input.slug ?? slugify(input.name);
  const existing = await db.tenant.findUnique({ where: { slug } });
  if (existing) {
    throw new AppError("conflict", "Tenant slug already taken", 409, "A tenant with this name already exists.");
  }

  const apiKey = `rl_${randomBytes(24).toString("hex")}`;
  const tenant = await db.tenant.create({
    data: {
      name: input.name,
      slug,
      brandName: input.brandName ?? null,
      brandColor: input.brandColor ?? null,
      billingEmail: input.billingEmail ?? null,
      monthlySpendLimit: input.monthlySpendLimit ?? 0,
      defaultMarkupPercent: input.defaultMarkupPercent ?? 0,
      apiKey,
      status: "active",
    },
  });

  logger.info("tenant.created", { tenantId: tenant.id, slug });
  return { id: tenant.id, name: tenant.name, slug: tenant.slug, apiKey: tenant.apiKey ?? "" };
}

/** Look up a tenant by slug. */
export async function getTenantBySlug(slug: string) {
  return db.tenant.findUnique({ where: { slug } });
}

/** Look up a tenant by API key. */
export async function getTenantByApiKey(apiKey: string) {
  return db.tenant.findUnique({ where: { apiKey } });
}

/** Get a tenant by id. */
export async function getTenant(tenantId: string) {
  return db.tenant.findUnique({ where: { id: tenantId } });
}

// ---------------------------------------------------------------------------
// Tenant users
// ---------------------------------------------------------------------------

/** Add a user to a tenant. */
export async function addTenantUser(input: {
  tenantId: string;
  userId: string;
  role?: "admin" | "member";
}): Promise<void> {
  const role = input.role ?? "admin";
  await db.tenantUser.create({
    data: { tenantId: input.tenantId, userId: input.userId, role },
  });
  await audit({
    userId: input.userId,
    action: "tenant.user_added",
    entity: "tenant",
    entityId: input.tenantId,
    detail: { role },
  });
}

/** Get the tenant a user belongs to (first membership). */
export async function getUserTenant(userId: string) {
  const membership = await db.tenantUser.findFirst({
    where: { userId },
    include: { tenant: true },
  });
  return membership?.tenant ?? null;
}

/**
 * Assert the user has one of the required roles in the tenant.
 * Throws AppError(authorization) if not.
 */
export async function assertTenantRole(
  tenantId: string,
  userId: string,
  roles: string[] = ["admin", "member"],
): Promise<void> {
  const membership = await db.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  });
  if (!membership || !roles.includes(membership.role)) {
    throw new AppError(
      "authorization",
      `User ${userId} is not a ${roles.join("|")} of tenant ${tenantId}`,
      403,
      "You don't have permission to perform this action for this tenant.",
    );
  }
}

// ---------------------------------------------------------------------------
// Distribution Offers (tenant-specific pricing)
// ---------------------------------------------------------------------------

/**
 * Create or update a tenant's DistributionOffer for a product. The retail
 * price is set by the tenant admin — this is the price the tenant's customers
 * will pay. The supplier never determines this price.
 */
export async function createDistributionOffer(input: {
  tenantId: string;
  productId: string;
  retailPriceMinor: number;
  currency?: string;
  markupPercent?: number;
  audience?: string;
}): Promise<{ id: string; retailPrice: number }> {
  const currency = input.currency ?? "USD";
  const audience = input.audience ?? "B2C";

  // Upsert by (productId, tenantId).
  const existing = await db.distributionOffer.findUnique({
    where: {
      productId_tenantId: {
        productId: input.productId,
        tenantId: input.tenantId,
      },
    },
  });

  if (existing) {
    const updated = await db.distributionOffer.update({
      where: { id: existing.id },
      data: {
        retailPrice: input.retailPriceMinor,
        currency,
        markupPercent: input.markupPercent ?? existing.markupPercent,
        status: "active",
        audience,
      },
    });
    return { id: updated.id, retailPrice: updated.retailPrice };
  }

  const offer = await db.distributionOffer.create({
    data: {
      productId: input.productId,
      tenantId: input.tenantId,
      retailPrice: input.retailPriceMinor,
      currency,
      markupPercent: input.markupPercent ?? 0,
      status: "active",
      audience,
    },
  });
  logger.info("tenant.distribution_offer.created", {
    offerId: offer.id,
    tenantId: input.tenantId,
    productId: input.productId,
    retailPrice: input.retailPriceMinor,
  });
  return { id: offer.id, retailPrice: offer.retailPrice };
}

/**
 * Get all DistributionOffers for a tenant. A tenant sees ONLY their own offers.
 */
export async function getDistributionOffers(tenantId: string) {
  return db.distributionOffer.findMany({
    where: { tenantId },
    include: { product: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get a single DistributionOffer for a tenant. Throws if the offer belongs to
 * a different tenant (cross-tenant isolation).
 */
export async function getDistributionOfferForTenant(
  offerId: string,
  tenantId: string,
) {
  const offer = await db.distributionOffer.findUnique({
    where: { id: offerId },
    include: { product: true },
  });
  if (!offer) {
    throw new AppError("not_found", "DistributionOffer not found", 404, "Offer not found.");
  }
  // Cross-tenant isolation: a tenant cannot read another tenant's offer.
  if ((offer.tenantId ?? null) !== (tenantId ?? null)) {
    throw new AppError(
      "authorization",
      `DistributionOffer ${offerId} does not belong to tenant ${tenantId}`,
      403,
      "You don't have access to this offer.",
    );
  }
  return offer;
}

// ---------------------------------------------------------------------------
// Orders (tenant-scoped)
// ---------------------------------------------------------------------------

/**
 * Get all orders for a tenant. A tenant sees ONLY their own orders.
 */
export async function getTenantOrders(tenantId: string) {
  return db.order.findMany({
    where: { tenantId },
    include: { plan: true, esim: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get a single order for a tenant. Throws if the order belongs to a different
 * tenant (cross-tenant isolation).
 */
export async function getTenantOrder(orderId: string, tenantId: string) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { plan: true, esim: true },
  });
  if (!order) {
    throw new AppError("not_found", "Order not found", 404, "Order not found.");
  }
  if ((order.tenantId ?? null) !== (tenantId ?? null)) {
    throw new AppError(
      "authorization",
      `Order ${orderId} does not belong to tenant ${tenantId}`,
      403,
      "You don't have access to this order.",
    );
  }
  return order;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
