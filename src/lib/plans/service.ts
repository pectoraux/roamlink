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
    if (existing) {
      await db.plan.update({
        where: { id: existing.id },
        data: { ...data, status: existing.status }, // preserve admin status toggles
      });
      updated += 1;
    } else {
      await db.plan.create({ data });
      created += 1;
    }
  }

  logger.info("sync.completed", { provider: provider.id, created, updated, total: providerPlans.length });
  return { created, updated, total: providerPlans.length };
}
