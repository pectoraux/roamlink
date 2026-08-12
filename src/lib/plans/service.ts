/**
 * Plan service — normalization, querying, and provider synchronization.
 *
 * Provider-native plan structures NEVER leak into the frontend. We normalize
 * them into CanonicalPlan. The DB Plan model is the persisted canonical form.
 */

import { db } from "@/lib/db";
import { getESIMProvider } from "@/lib/esim";
import { computeRetailPrice, ensureDefaultPricingRules } from "./pricing";
import { logger } from "@/lib/logger";
import type { CanonicalPlan, PublicPlan } from "@/types";
import type { Currency } from "@/lib/money";
import { computeProductIdentity } from "@/lib/catalog/identity";

/** Convert a DB Plan row into a canonical plan (internal). */
export function dbPlanToCanonical(p: {
  id: string;
  providerId: string;
  providerPlanId: string;
  name: string;
  description: string | null;
  country: string;
  countryCode: string;
  region: string;
  dataAmount: number;
  dataUnit: string;
  validityDays: number;
  price: number;
  wholesalePrice: number;
  currency: string;
  coverage: string | null;
  networks: string | null;
  roaming: boolean;
  hotspot: boolean;
  speed: string | null;
  topUpSupported: boolean;
  status: string;
}): CanonicalPlan {
  return {
    id: p.id,
    providerId: p.providerId,
    providerPlanId: p.providerPlanId,
    name: p.name,
    description: p.description,
    country: p.country,
    countryCode: p.countryCode,
    region: p.region,
    dataAmountMB: p.dataAmount,
    dataUnit: p.dataUnit,
    validityDays: p.validityDays,
    priceMinor: p.price,
    currency: p.currency as Currency,
    coverage: p.coverage,
    networks: p.networks ? safeParse(p.networks, []) : [],
    roaming: p.roaming,
    hotspot: p.hotspot,
    speed: p.speed,
    topUpSupported: p.topUpSupported,
    status: p.status as "active" | "inactive",
  };
}

/** Convert a canonical plan into a PUBLIC plan (no wholesale cost). */
export function toPublicPlan(p: CanonicalPlan): PublicPlan {
  // Omit wholesale — it's not on PublicPlan type anyway. Keep providerId key.
  return {
    id: p.id,
    providerId: p.providerId,
    name: p.name,
    description: p.description,
    country: p.country,
    countryCode: p.countryCode,
    region: p.region,
    dataAmountMB: p.dataAmountMB,
    dataUnit: p.dataUnit,
    validityDays: p.validityDays,
    priceMinor: p.priceMinor,
    currency: p.currency,
    coverage: p.coverage,
    networks: p.networks,
    roaming: p.roaming,
    hotspot: p.hotspot,
    speed: p.speed,
    topUpSupported: p.topUpSupported,
    status: p.status,
  };
}

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export type PlanQuery = {
  search?: string;
  countryCode?: string;
  region?: string;
  minDataMB?: number;
  maxDataMB?: number;
  minValidityDays?: number;
  maxValidityDays?: number;
  sort?: "price_asc" | "price_desc" | "data_asc" | "data_desc" | "validity_desc";
  status?: "active" | "inactive";
};

/** Query active plans with filters. */
export async function listPlans(query: PlanQuery = {}): Promise<PublicPlan[]> {
  const where: Record<string, unknown> = { status: query.status ?? "active" };
  if (query.countryCode) where.countryCode = query.countryCode;
  if (query.region) where.region = query.region;
  if (query.minDataMB != null || query.maxDataMB != null) {
    where.dataAmount = {};
    if (query.minDataMB != null) where.dataAmount.gte = query.minDataMB;
    if (query.maxDataMB != null) where.dataAmount.lte = query.maxDataMB;
  }
  if (query.minValidityDays != null || query.maxValidityDays != null) {
    where.validityDays = {};
    if (query.minValidityDays != null) where.validityDays.gte = query.minValidityDays;
    if (query.maxValidityDays != null) where.validityDays.lte = query.maxValidityDays;
  }

  let orderBy: Record<string, string> = { price: "asc" };
  switch (query.sort) {
    case "price_asc": orderBy = { price: "asc" }; break;
    case "price_desc": orderBy = { price: "desc" }; break;
    case "data_asc": orderBy = { dataAmount: "asc" }; break;
    case "data_desc": orderBy = { dataAmount: "desc" }; break;
    case "validity_desc": orderBy = { validityDays: "desc" }; break;
  }

  let plans = await db.plan.findMany({ where, orderBy });
  if (query.search) {
    const q = query.search.toLowerCase();
    plans = plans.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.country.toLowerCase().includes(q) ||
        p.countryCode.toLowerCase().includes(q) ||
        p.region.toLowerCase().includes(q),
    );
  }
  return plans.map((p) => toPublicPlan(dbPlanToCanonical(p)));
}

/** Get a single public plan by id. */
export async function getPublicPlan(id: string): Promise<PublicPlan | null> {
  const p = await db.plan.findUnique({ where: { id } });
  if (!p) return null;
  return toPublicPlan(dbPlanToCanonical(p));
}

/** Get a canonical plan (internal, includes wholesale). */
export async function getCanonicalPlan(id: string): Promise<CanonicalPlan | null> {
  const p = await db.plan.findUnique({ where: { id } });
  if (!p) return null;
  return dbPlanToCanonical(p);
}

/** Popular destinations (distinct countries with active plans, by order count). */
export async function getPopularDestinations(limit = 8): Promise<{ country: string; countryCode: string; region: string; planCount: number; minPriceMinor: number }[]> {
  const plans = await db.plan.findMany({ where: { status: "active" } });
  const byCountry = new Map<string, { country: string; countryCode: string; region: string; planCount: number; minPriceMinor: number }>();
  for (const p of plans) {
    const key = p.countryCode;
    const existing = byCountry.get(key);
    if (existing) {
      existing.planCount += 1;
      existing.minPriceMinor = Math.min(existing.minPriceMinor, p.price);
    } else {
      byCountry.set(key, { country: p.country, countryCode: p.countryCode, region: p.region, planCount: 1, minPriceMinor: p.price });
    }
  }
  return Array.from(byCountry.values()).slice(0, limit);
}

/** Distinct regions with active plans. */
export async function getRegions(): Promise<string[]> {
  const plans = await db.plan.findMany({ where: { status: "active" }, select: { region: true } });
  return Array.from(new Set(plans.map((p) => p.region))).sort();
}

/** Distinct countries with active plans. */
export async function getCountries(): Promise<{ country: string; countryCode: string }[]> {
  const plans = await db.plan.findMany({ where: { status: "active" }, select: { country: true, countryCode: true } });
  const seen = new Map<string, { country: string; countryCode: string }>();
  for (const p of plans) seen.set(p.countryCode, p);
  return Array.from(seen.values()).sort((a, b) => a.country.localeCompare(b.country));
}

/** Convert a country name to an SEO-friendly slug. */
export function countryToSlug(country: string): string {
  return country
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Convert a slug back to a country name (best-effort). */
export function slugToCountry(slug: string, countries: { country: string; countryCode: string }[]): string | null {
  const target = slug.toLowerCase().replace(/-/g, " ");
  const match = countries.find((c) => c.country.toLowerCase() === target);
  if (match) return match.country;
  // Try without spaces (e.g., "cotedivoire" → "Côte d'Ivoire")
  const match2 = countries.find((c) => c.country.toLowerCase().replace(/[^a-z]/g, "") === slug.replace(/-/g, "").toLowerCase());
  return match2?.country ?? null;
}

export type DestinationPage = {
  country: string;
  countryCode: string;
  region: string;
  slug: string;
  plans: PublicPlan[];
  coverage: string | null;
  networks: string[];
  speed: string | null;
  minPriceMinor: number;
  planCount: number;
};

/** Get a full destination page (country + all its plans). Returns null if no plans. */
export async function getDestinationByCountry(country: string): Promise<DestinationPage | null> {
  const plans = await db.plan.findMany({ where: { status: "active", country }, orderBy: { price: "asc" } });
  if (plans.length === 0) return null;
  const publicPlans = plans.map((p) => toPublicPlan(dbPlanToCanonical(p)));
  const first = plans[0];
  const allNetworks = new Set<string>();
  plans.forEach((p) => {
    if (p.networks) {
      try { (JSON.parse(p.networks) as string[]).forEach((n) => allNetworks.add(n)); } catch { /* noop */ }
    }
  });
  return {
    country: first.country,
    countryCode: first.countryCode,
    region: first.region,
    slug: countryToSlug(first.country),
    plans: publicPlans,
    coverage: first.coverage,
    networks: Array.from(allNetworks).sort(),
    speed: first.speed,
    minPriceMinor: Math.min(...plans.map((p) => p.price)),
    planCount: plans.length,
  };
}

/** Get a destination by slug. */
export async function getDestinationBySlug(slug: string): Promise<DestinationPage | null> {
  const countries = await getCountries();
  const country = slugToCountry(slug, countries);
  if (!country) return null;
  return getDestinationByCountry(country);
}

/** All destinations for sitemap generation. */
export async function getAllDestinations(): Promise<{ country: string; countryCode: string; slug: string }[]> {
  const countries = await getCountries();
  return countries.map((c) => ({ ...c, slug: countryToSlug(c.country) }));
}

// ---------------------------------------------------------------------------
// Provider synchronization
// ---------------------------------------------------------------------------

/**
 * Synchronize plans from the eSIM provider into the database.
 *
 *   Provider -> Fetch plans -> Normalize -> Validate -> Upsert -> Publish
 *
 * Provider-specific structures never leak past this function.
 */
export async function syncPlansFromProvider(): Promise<{
  created: number;
  updated: number;
  total: number;
}> {
  await ensureDefaultPricingRules();
  const provider = getESIMProvider();
  const providerPlans = await provider.getPlans();
  let created = 0;
  let updated = 0;

  for (const pp of providerPlans) {
    // Validate
    if (!pp.providerPlanId || !pp.country || !pp.countryCode || pp.dataAmountMB <= 0 || pp.validityDays <= 0 || pp.wholesalePriceMinor < 0) {
      logger.warn("sync.plan_skipped_invalid", { providerPlanId: pp.providerPlanId });
      continue;
    }

    // Compute retail price via pricing engine.
    const decision = await computeRetailPrice({
      wholesaleMinor: pp.wholesalePriceMinor,
      countryCode: pp.countryCode,
      region: pp.region,
      currency: pp.currency,
    });

    const data = {
      providerId: provider.id,
      providerPlanId: pp.providerPlanId,
      name: pp.name,
      description: pp.description ?? null,
      country: pp.country,
      countryCode: pp.countryCode,
      region: pp.region,
      dataAmount: pp.dataAmountMB,
      dataUnit: "MB",
      validityDays: pp.validityDays,
      price: decision.retailMinor,
      wholesalePrice: pp.wholesalePriceMinor,
      currency: pp.currency,
      coverage: pp.coverage ?? null,
      networks: pp.networks ? JSON.stringify(pp.networks) : null,
      roaming: pp.roaming ?? false,
      hotspot: pp.hotspot ?? true,
      speed: pp.speed ?? null,
      topUpSupported: pp.topUpSupported ?? true,
      status: "active",
      pricingRule: JSON.stringify({ name: decision.ruleName, type: decision.ruleType, value: decision.ruleValue }),
      metadata: pp.metadata ? JSON.stringify(pp.metadata) : null,
    };

    const existing = await db.plan.findUnique({
      where: { providerId_providerPlanId: { providerId: provider.id, providerPlanId: pp.providerPlanId } },
    });
    let planId: string;
    if (existing) {
      await db.plan.update({
        where: { id: existing.id },
        data: { ...data, status: existing.status }, // preserve admin status toggles
      });
      planId = existing.id;
      updated += 1;
    } else {
      const created_row = await db.plan.create({ data });
      planId = created_row.id;
      created += 1;
    }

    // Phase 2C: sync this Plan into the canonical catalog. This creates (or
    // converges onto) a ConnectivityProduct with a stable identityHash, then
    // upserts a ConnectivityOffer for the active supplier. Two suppliers
    // syncing the same canonical product will end up sharing one
    // ConnectivityProduct row, each with their own ConnectivityOffer.
    await syncPlanToCatalog({
      planId,
      name: pp.name,
      country: pp.country,
      countryCode: pp.countryCode,
      region: pp.region,
      dataAmountMB: pp.dataAmountMB,
      validityDays: pp.validityDays,
      wholesalePriceMinor: pp.wholesalePriceMinor,
      currency: pp.currency,
      supplierProviderKey: provider.id,
      supplierName: provider.label,
    });
  }

  logger.info("sync.completed", { provider: provider.id, created, updated, total: providerPlans.length });
  return { created, updated, total: providerPlans.length };
}

// ===========================================================================
// Phase 2C — Catalog sync convergence
// ===========================================================================

/**
 * Ensure a Supplier row exists for the given provider key. The Supplier is
 * the orchestration-engine-facing entity that the engine selects between.
 */
async function ensureSupplier(input: {
  providerKey: string;
  name: string;
  type?: string;
}): Promise<{ id: string; providerKey: string | null; name: string }> {
  const existing = await db.supplier.findUnique({ where: { name: input.name } });
  if (existing) return existing;
  const supplier = await db.supplier.create({
    data: {
      name: input.name,
      type: input.type ?? "ESIM",
      providerKey: input.providerKey,
      redistributionPolicy: "B2C_AND_B2B",
      healthStatus: "healthy",
      active: true,
    },
  });
  logger.info("catalog.supplier.created", { supplierId: supplier.id, providerKey: input.providerKey });
  return supplier;
}

/**
 * Sync a single Plan into the canonical connectivity catalog.
 *
 *   1. Compute the canonical identity hash from the plan's normalized attributes.
 *   2. Look up an existing ConnectivityProduct by identityHash. If found, this
 *      supplier is being converged onto an already-known canonical product.
 *   3. Otherwise, look up by sourcePlanId (the Plan that originated this sync).
 *      If found, update its identityHash. Otherwise create a new product.
 *   4. Ensure a ConnectivityOffer exists for (product, supplier) with this
 *      supplier's wholesale price.
 *
 * This is what makes "two independent supplier catalog syncs actually
 * converge onto one ConnectivityProduct" (test scenario 7).
 */
export async function syncPlanToCatalog(input: {
  planId: string;
  name: string;
  country: string;
  countryCode: string;
  region: string;
  dataAmountMB: number;
  validityDays: number;
  wholesalePriceMinor: number;
  currency: string;
  supplierProviderKey: string;
  supplierName: string;
}): Promise<{
  productId: string;
  offerId: string;
  converged: boolean; // true if the product already existed (from another supplier)
}> {
  const identity = computeProductIdentity({
    type: "ESIM",
    name: input.name,
    country: input.country,
    countryCode: input.countryCode,
    region: input.region,
    dataAmountMB: input.dataAmountMB,
    validityDays: input.validityDays,
    capabilities: ["DATA", "ESIM"],
  });

  // 1. Look up by identityHash — supplier convergence path.
  let product = await db.connectivityProduct.findFirst({
    where: { identityHash: identity.identityHash },
  });

  let converged = false;
  if (product) {
    converged = true;
    // If this product was originally created from a different sourcePlanId,
    // we keep the original sourcePlanId (canonical identity wins). Otherwise
    // stamp it.
    if (!product.sourcePlanId) {
      product = await db.connectivityProduct.update({
        where: { id: product.id },
        data: { sourcePlanId: input.planId },
      });
    }
  } else {
    // 2. Look up by sourcePlanId — the Plan that originated this product.
    product = await db.connectivityProduct.findUnique({
      where: { sourcePlanId: input.planId },
    });

    if (product) {
      // Update the identity hash (in case the plan was re-synced with new attributes).
      product = await db.connectivityProduct.update({
        where: { id: product.id },
        data: {
          name: input.name,
          country: input.country,
          countryCode: input.countryCode,
          region: input.region,
          dataAmountMB: input.dataAmountMB,
          validityDays: input.validityDays,
          canonicalSpecification: identity.canonicalSpecification,
          identityHash: identity.identityHash,
        },
      });
    } else {
      // 3. Create a new canonical product.
      product = await db.connectivityProduct.create({
        data: {
          type: "ESIM",
          name: input.name,
          description: `${input.name} — canonical connectivity product`,
          country: input.country,
          countryCode: input.countryCode,
          region: input.region,
          dataAmountMB: input.dataAmountMB,
          validityDays: input.validityDays,
          capabilities: JSON.stringify(["DATA", "ESIM"]),
          sourcePlanId: input.planId,
          canonicalSpecification: identity.canonicalSpecification,
          identityHash: identity.identityHash,
          active: true,
        },
      });
      logger.info("catalog.product.created", {
        productId: product.id,
        sourcePlanId: input.planId,
        identityHash: identity.identityHash,
      });
    }
  }

  // 4. Ensure a ConnectivityOffer for (product, supplier).
  const supplier = await ensureSupplier({
    providerKey: input.supplierProviderKey,
    name: input.supplierName,
    type: "ESIM",
  });

  // ConnectivityOffer unique on (productId, supplierId)? No — only the
  // DistributionOffer has that unique constraint. A supplier can have multiple
  // offers for the same product (e.g. wholesale tiers). We upsert by
  // (productId, supplierId) via findFirst + create/update.
  const existingOffer = await db.connectivityOffer.findFirst({
    where: { productId: product.id, supplierId: supplier.id },
  });

  // Retail price for the ConnectivityOffer is the wholesale + a small margin
  // (used only as a fallback when no DistributionOffer exists). The actual
  // tenant retail price is always sourced from the DistributionOffer.
  const fallbackRetail = Math.round(input.wholesalePriceMinor * 1.3);

  let offer;
  if (existingOffer) {
    offer = await db.connectivityOffer.update({
      where: { id: existingOffer.id },
      data: {
        wholesalePrice: input.wholesalePriceMinor,
        retailPrice: fallbackRetail,
        currency: input.currency,
        status: "active",
      },
    });
  } else {
    offer = await db.connectivityOffer.create({
      data: {
        productId: product.id,
        supplierId: supplier.id,
        wholesalePrice: input.wholesalePriceMinor,
        retailPrice: fallbackRetail,
        currency: input.currency,
        status: "active",
        audiences: "B2C,B2B",
        supplierProductId: input.planId,
      },
    });
  }

  logger.info("catalog.synced", {
    planId: input.planId,
    productId: product.id,
    offerId: offer.id,
    converged,
    supplierId: supplier.id,
  });

  return { productId: product.id, offerId: offer.id, converged };
}
