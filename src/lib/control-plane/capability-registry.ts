/**
 * Control Plane — Capability Registry
 *
 * Allows providers to advertise connectivity capabilities WITHOUT creating
 * commercial products. This is the moment RoamLink genuinely becomes a
 * protocol: a provider can publish "I have 100Mbps WiFi in Accra" without
 * creating a Product, Order, or Checkout flow.
 *
 * Architecture:
 *   Provider → advertiseCapabilities() → ConnectivityCapability records
 *   Decision Engine → queries capabilities → matches against intent
 *   Commerce (optional) → creates ConnectivityOffer from capability + price
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Advertise a Capability
// ---------------------------------------------------------------------------

/**
 * A provider advertises a connectivity capability. This is the supply-side
 * of the protocol — it says "I can provide this type of connectivity with
 * these quality characteristics in this geographic area."
 *
 * This does NOT create a product, offer, or price. It only registers the
 * technical supply. The commerce layer can later create an offer from this
 * capability + commercial terms.
 */
export async function advertiseCapability(input: {
  tenantId: string;
  providerInstanceId: string;
  type: string; // INTERNET | ROAMING | LOCAL_NETWORK | VPN_ACCESS
  providerType: string; // mikrotik | esim | telco | future
  bandwidth?: { downloadMbps?: number; uploadMbps?: number };
  latency?: { typicalMs?: number; maxMs?: number };
  reliability?: number; // 0.0–1.0
  geographicCoverage?: { countries?: string[]; regions?: string[]; cities?: string[] };
  mobility?: boolean;
  metering?: string; // UNMETERED | METERED | PREPAID
}): Promise<{ capabilityId: string }> {
  // Store as a ConnectivityOffer2 with no pricing (wholesalePrice = 0, customerPrice = 0)
  // This reuses the existing model — the capability IS an offer with zero price
  // until commerce assigns pricing.
  const spec: Record<string, unknown> = {};
  if (input.bandwidth?.downloadMbps) spec.downloadMbps = input.bandwidth.downloadMbps;
  if (input.bandwidth?.uploadMbps) spec.uploadMbps = input.bandwidth.uploadMbps;

  const coverage: Record<string, unknown> = {};
  if (input.geographicCoverage?.countries) coverage.countries = input.geographicCoverage.countries;
  if (input.geographicCoverage?.regions) coverage.regions = input.geographicCoverage.regions;
  if (input.geographicCoverage?.cities) coverage.cities = input.geographicCoverage.cities;

  const offer = await db.connectivityOffer2.create({
    data: {
      tenantId: input.tenantId,
      capabilityType: input.type,
      providerType: input.providerType,
      spec: JSON.stringify(spec),
      coverage: JSON.stringify(coverage),
      wholesalePriceMinor: 0,
      customerPriceMinor: 0,
      currency: "USD",
      supplierId: null, // own infrastructure
      status: "active",
      reliabilityScore: input.reliability ?? 0.5,
    },
  });

  logger.info("capability.advertised", {
    capabilityId: offer.id,
    tenantId: input.tenantId,
    type: input.type,
    providerType: input.providerType,
  });

  return { capabilityId: offer.id };
}

// ---------------------------------------------------------------------------
// Discover Capabilities
// ---------------------------------------------------------------------------

/**
 * Discover capabilities that match a location and/or type.
 *
 * This is what the decision engine calls to find candidate connectivity
 * options for a user's intent. It does NOT return prices — capabilities
 * are technical supply, not commercial offers.
 */
export async function discoverCapabilities(input: {
  tenantId: string;
  type?: string;
  country?: string;
  city?: string;
  minReliability?: number;
}): Promise<Array<{
  id: string;
  type: string;
  providerType: string;
  spec: Record<string, unknown>;
  coverage: Record<string, unknown>;
  reliability: number;
}>> {
  const offers = await db.connectivityOffer2.findMany({
    where: {
      tenantId: input.tenantId,
      status: "active",
      ...(input.type && { capabilityType: input.type }),
      ...(input.minReliability && { reliabilityScore: { gte: input.minReliability } }),
    },
    orderBy: { reliabilityScore: "desc" },
  });

  // Filter by location if specified
  return offers
    .map((o) => {
      const spec = JSON.parse(o.spec);
      const coverage = JSON.parse(o.coverage);
      return {
        id: o.id,
        type: o.capabilityType,
        providerType: o.providerType,
        spec,
        coverage,
        reliability: o.reliabilityScore,
      };
    })
    .filter((cap) => {
      if (!input.country && !input.city) return true;
      const countries = (cap.coverage as Record<string, unknown>).countries as string[] | undefined;
      const cities = (cap.coverage as Record<string, unknown>).cities as string[] | undefined;
      if (input.country && countries && !countries.includes(input.country)) return false;
      if (input.city && cities && !cities.includes(input.city)) return false;
      return true;
    });
}

// ---------------------------------------------------------------------------
// Get Capability
// ---------------------------------------------------------------------------

export async function getCapability(capabilityId: string) {
  const offer = await db.connectivityOffer2.findUnique({
    where: { id: capabilityId },
  });

  if (!offer) return null;

  return {
    id: offer.id,
    type: offer.capabilityType,
    providerType: offer.providerType,
    spec: JSON.parse(offer.spec),
    coverage: JSON.parse(offer.coverage),
    reliability: offer.reliabilityScore,
    wholesalePriceMinor: offer.wholesalePriceMinor,
    customerPriceMinor: offer.customerPriceMinor,
    currency: offer.currency,
    supplierId: offer.supplierId,
    status: offer.status,
    successCount: offer.successCount,
    failureCount: offer.failureCount,
  };
}
