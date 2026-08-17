/**
 * Phase 4 — Offer Ranking Engine
 *
 * The deterministic core that resolves a ConnectivityIntent into a ranked
 * list of ConnectivityOffer2 results. No AI — pure deterministic scoring.
 *
 * Scoring dimensions (each 0.0–1.0, weighted, summed):
 *   1. Intent match    — does the offer's spec satisfy what the customer wants?
 *   2. Location match  — does the offer cover where the customer is?
 *   3. Availability    — is the offer active and not exhausted/expired?
 *   4. Price           — how competitive is the customer price? (lower = better)
 *   5. Margin          — how much margin does the reseller make? (higher = better)
 *   6. Reliability     — the offer's historical success rate
 *
 * The engine is supplier-neutral: it doesn't care whether the offer comes
 * from a WiFi operator's own infrastructure, a telco reseller's imported
 * catalog, or an eSIM supplier's feed. All offers are normalized into
 * ConnectivityOffer2 rows and scored identically.
 *
 * The weights are configurable per tenant (resellers can prioritize margin
 * vs. price vs. reliability). The defaults favor reliability + price.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OfferSpec = {
  downloadMbps?: number;
  uploadMbps?: number;
  dataLimitBytes?: number;
  validityDays?: number;
  allowedCountries?: string[];
  allowedRegions?: string[];
};

export type OfferCoverage = {
  countries?: string[];
  regions?: string[];
  cities?: string[];
  lat?: number;
  lng?: number;
  radiusKm?: number;
};

export type CustomerLocation = {
  country?: string;
  region?: string;
  city?: string;
  lat?: number;
  lng?: number;
};

export type IntentInput = {
  tenantId: string;
  customerId?: string;
  capabilityType?: string;
  desiredSpec?: OfferSpec;
  location?: CustomerLocation;
  maxPriceMinor?: number;
};

export type RankedOffer = {
  offerId: string;
  score: number;
  customerPriceMinor: number;
  matchReasons: string[];
  scores: {
    intentMatch: number;
    locationMatch: number;
    availability: number;
    price: number;
    margin: number;
    reliability: number;
  };
  offer: {
    capabilityType: string;
    providerType: string;
    spec: OfferSpec;
    coverage: OfferCoverage;
    wholesalePriceMinor: number;
    customerPriceMinor: number;
    currency: string;
    supplierId: string | null;
    reliabilityScore: number;
  };
};

export type RankingWeights = {
  intentMatch: number;
  locationMatch: number;
  availability: number;
  price: number;
  margin: number;
  reliability: number;
};

// Default weights: reliability + price are most important, then intent +
// location match, then margin, then availability (binary-ish).
export const DEFAULT_WEIGHTS: RankingWeights = {
  intentMatch: 0.20,
  locationMatch: 0.15,
  availability: 0.10,
  price: 0.25,
  margin: 0.10,
  reliability: 0.20,
};

// ---------------------------------------------------------------------------
// The Ranking Engine
// ---------------------------------------------------------------------------

/**
 * Resolve a customer's connectivity intent into a ranked list of offers.
 *
 * This is a PURE, DETERMINISTIC function of (intent, offers, weights).
 * No AI, no randomness, no external calls during scoring. The same inputs
 * always produce the same ranking.
 */
export async function rankOffers(
  intent: IntentInput,
  weights: RankingWeights = DEFAULT_WEIGHTS,
): Promise<{ intentId: string; ranked: RankedOffer[] }> {
  // Step 1: Fetch all active offers for this tenant
  const offers = await db.connectivityOffer2.findMany({
    where: {
      tenantId: intent.tenantId,
      status: "active",
    },
  });

  logger.info("ranking.engine", {
    tenantId: intent.tenantId,
    offerCount: offers.length,
    intent: { capabilityType: intent.capabilityType, hasLocation: !!intent.location },
  });

  // Step 2: Score each offer
  const scored: RankedOffer[] = [];

  for (const offer of offers) {
    const spec = JSON.parse(offer.spec) as OfferSpec;
    const coverage = JSON.parse(offer.coverage) as OfferCoverage;

    // Filter: capability type must match (if intent specifies one)
    if (intent.capabilityType && offer.capabilityType !== intent.capabilityType) {
      continue;
    }

    // Phase 9.5.3: Do NOT filter by budget here. The ranking engine should
    // return ALL offers ranked by score. The decision engine evaluates budget
    // as a policy constraint (BUDGET_CONSTRAINT / OVER_BUDGET) — the ranking
    // engine must not silently exclude over-budget candidates.
    // This preserves: Commerce ranking ≠ Connectivity Control Plane policy.

    // Score each dimension
    const intentMatchScore = scoreIntentMatch(intent.desiredSpec, spec);
    const locationMatchScore = scoreLocationMatch(intent.location, coverage);
    const availabilityScore = scoreAvailability(offer.status, offer.validUntil);
    const priceScore = scorePrice(offer.customerPriceMinor, offers.map((o) => o.customerPriceMinor));
    const marginScore = scoreMargin(offer.wholesalePriceMinor, offer.customerPriceMinor);
    const reliabilityScore = offer.reliabilityScore;

    // Weighted sum
    const totalScore =
      intentMatchScore * weights.intentMatch +
      locationMatchScore * weights.locationMatch +
      availabilityScore * weights.availability +
      priceScore * weights.price +
      marginScore * weights.margin +
      reliabilityScore * weights.reliability;

    // Collect match reasons for transparency
    const matchReasons: string[] = [];
    if (intentMatchScore >= 0.8) matchReasons.push("spec matches intent");
    if (locationMatchScore >= 0.8) matchReasons.push("covers customer location");
    if (priceScore >= 0.8) matchReasons.push("competitive price");
    if (reliabilityScore >= 0.8) matchReasons.push("high reliability");
    if (marginScore >= 0.8) matchReasons.push("high margin for reseller");

    scored.push({
      offerId: offer.id,
      score: Math.round(totalScore * 1000) / 1000, // 3 decimal places
      customerPriceMinor: offer.customerPriceMinor,
      matchReasons,
      scores: {
        intentMatch: Math.round(intentMatchScore * 1000) / 1000,
        locationMatch: Math.round(locationMatchScore * 1000) / 1000,
        availability: Math.round(availabilityScore * 1000) / 1000,
        price: Math.round(priceScore * 1000) / 1000,
        margin: Math.round(marginScore * 1000) / 1000,
        reliability: Math.round(reliabilityScore * 1000) / 1000,
      },
      offer: {
        capabilityType: offer.capabilityType,
        providerType: offer.providerType,
        spec,
        coverage,
        wholesalePriceMinor: offer.wholesalePriceMinor,
        customerPriceMinor: offer.customerPriceMinor,
        currency: offer.currency,
        supplierId: offer.supplierId,
        reliabilityScore,
      },
    });
  }

  // Step 3: Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Step 4: Persist the intent + ranked results (for analytics + debugging)
  const intentRecord = await db.connectivityIntent.create({
    data: {
      tenantId: intent.tenantId,
      customerId: intent.customerId,
      capabilityType: intent.capabilityType ?? null,
      desiredSpec: intent.desiredSpec ? JSON.stringify(intent.desiredSpec) : null,
      location: intent.location ? JSON.stringify(intent.location) : null,
      maxPriceMinor: intent.maxPriceMinor ?? null,
      rankedResults: JSON.stringify(scored.slice(0, 20)), // top 20
    },
  });

  logger.info("ranking.completed", {
    intentId: intentRecord.id,
    rankedCount: scored.length,
    topScore: scored[0]?.score ?? 0,
  });

  return { intentId: intentRecord.id, ranked: scored };
}

// ---------------------------------------------------------------------------
// Scoring Functions (each returns 0.0–1.0)
// ---------------------------------------------------------------------------

/**
 * Score how well an offer's spec satisfies the customer's desired spec.
 *
 * - If the customer doesn't specify a desired spec, return 1.0 (any offer matches).
 * - For each spec field the customer specifies, check if the offer meets or exceeds it.
 * - Fields the customer doesn't specify are ignored (don't penalize).
 */
function scoreIntentMatch(desired: OfferSpec | undefined, actual: OfferSpec): number {
  if (!desired) return 1.0; // no preference = any matches

  let points = 0;
  let maxPoints = 0;

  if (desired.downloadMbps) {
    maxPoints++;
    if (actual.downloadMbps && actual.downloadMbps >= desired.downloadMbps) {
      points += 1.0;
    } else if (actual.downloadMbps && actual.downloadMbps >= (desired.downloadMbps * 0.8)) {
      points += 0.5; // within 80% of desired
    }
  }

  if (desired.uploadMbps) {
    maxPoints++;
    if (actual.uploadMbps && actual.uploadMbps >= desired.uploadMbps) {
      points += 1.0;
    } else if (actual.uploadMbps && actual.uploadMbps >= (desired.uploadMbps * 0.8)) {
      points += 0.5;
    }
  }

  if (desired.dataLimitBytes) {
    maxPoints++;
    if (actual.dataLimitBytes && actual.dataLimitBytes >= desired.dataLimitBytes) {
      points += 1.0;
    } else if (actual.dataLimitBytes && actual.dataLimitBytes >= (desired.dataLimitBytes * 0.8)) {
      points += 0.5;
    }
  }

  if (desired.validityDays) {
    maxPoints++;
    if (actual.validityDays && actual.validityDays >= desired.validityDays) {
      points += 1.0;
    }
  }

  if (desired.allowedCountries && desired.allowedCountries.length > 0) {
    maxPoints++;
    const actualCountries = actual.allowedCountries ?? [];
    const overlap = desired.allowedCountries.filter((c) => actualCountries.includes(c));
    if (overlap.length === desired.allowedCountries.length) {
      points += 1.0; // full coverage
    } else if (overlap.length > 0) {
      points += overlap.length / desired.allowedCountries.length; // partial
    }
  }

  return maxPoints === 0 ? 1.0 : points / maxPoints;
}

/**
 * Score how well an offer's coverage matches the customer's location.
 *
 * - If the customer doesn't specify a location, return 1.0 (any offer matches).
 * - If the offer has no coverage info, return 0.5 (neutral — might match).
 * - Country match is the strongest signal.
 * - Region match is secondary.
 * - Geo-radius match is tertiary (if both have lat/lng).
 */
function scoreLocationMatch(location: CustomerLocation | undefined, coverage: OfferCoverage): number {
  if (!location) return 1.0; // no location preference = any matches

  // No coverage info on the offer — neutral
  if (!coverage.countries?.length && !coverage.regions?.length && !coverage.cities?.length && !coverage.lat) {
    return 0.5;
  }

  let score = 0;
  let factors = 0;

  // Country match (strongest)
  if (location.country) {
    factors++;
    if (coverage.countries?.includes(location.country)) {
      score += 1.0;
    }
  }

  // Region match
  if (location.region) {
    factors++;
    if (coverage.regions?.includes(location.region)) {
      score += 1.0;
    }
  }

  // City match
  if (location.city) {
    factors++;
    if (coverage.cities?.includes(location.city)) {
      score += 1.0;
    }
  }

  // Geo-radius match (Haversine distance)
  if (location.lat && location.lng && coverage.lat && coverage.lng && coverage.radiusKm) {
    factors++;
    const distance = haversineKm(location.lat, location.lng, coverage.lat, coverage.lng);
    if (distance <= coverage.radiusKm) {
      score += 1.0;
    } else if (distance <= coverage.radiusKm * 1.5) {
      score += 0.5; // within 150% of radius
    }
  }

  return factors === 0 ? 0.5 : score / factors;
}

/**
 * Score availability: is the offer active and not expired?
 */
function scoreAvailability(status: string, validUntil: Date | null): number {
  if (status !== "active") return 0.0;

  const now = new Date();
  if (validUntil && validUntil < now) return 0.0; // expired

  // Active and not expired
  // If validUntil is far in the future, give it a small boost
  if (validUntil) {
    const daysRemaining = (validUntil.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (daysRemaining > 30) return 1.0;
    if (daysRemaining > 7) return 0.8;
    if (daysRemaining > 1) return 0.5;
    return 0.2; // expiring soon
  }

  return 1.0; // active, no expiry
}

/**
 * Score price competitiveness: lower price = higher score.
 *
 * Normalized relative to the cheapest and most expensive offers in the set.
 * If there's only one offer, it gets 1.0 (no competition).
 */
function scorePrice(customerPriceMinor: number, allPrices: number[]): number {
  const validPrices = allPrices.filter((p) => p > 0);
  if (validPrices.length <= 1) return 1.0;

  const min = Math.min(...validPrices);
  const max = Math.max(...validPrices);

  if (min === max) return 1.0; // all same price

  // Linear normalization: cheapest = 1.0, most expensive = 0.0
  return (max - customerPriceMinor) / (max - min);
}

/**
 * Score margin: higher margin for the reseller = higher score.
 *
 * Margin = customerPrice - wholesalePrice.
 * Normalized relative to the max margin in the set.
 */
function scoreMargin(wholesalePriceMinor: number, customerPriceMinor: number): number {
  const margin = customerPriceMinor - wholesalePriceMinor;
  if (margin <= 0) return 0.0; // no margin or loss

  // Score based on margin as a percentage of customer price
  const marginPercent = margin / customerPriceMinor;
  // 0% margin = 0.0, 50%+ margin = 1.0
  return Math.min(1.0, marginPercent / 0.5);
}

// ---------------------------------------------------------------------------
// Haversine distance (for geo-radius matching)
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
