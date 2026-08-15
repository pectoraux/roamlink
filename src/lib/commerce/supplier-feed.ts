/**
 * Phase 4 — Supplier Feed Ingestion
 *
 * Normalizes products from any supplier (eSIM roaming feed, telco product
 * catalog, WiFi operator's own infrastructure) into ConnectivityOffer2 rows
 * that the ranking engine can compare on a level playing field.
 *
 * Three ingestion paths:
 *   1. ingestOwnInfrastructure() — a WiFi operator publishes their own hotspot
 *      plans as offers (supplierId = null, no markup).
 *   2. ingestSupplierFeed() — an eSIM supplier's roaming product catalog is
 *      imported (supplierId = the supplier, markup applied).
 *   3. ingestTelcoProduct() — a telco reseller imports a telecom product
 *      (supplierId = the telco, markup applied).
 *
 * All three produce the same ConnectivityOffer2 shape — the ranking engine
 * doesn't know or care which path created the offer.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { calculateCustomerPrice } from "./markup-engine";

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

export type IngestOfferInput = {
  tenantId: string;
  capabilityType: string;
  providerType: string;
  spec: OfferSpec;
  coverage: OfferCoverage;
  wholesalePriceMinor: number;
  currency: string;
  supplierId?: string | null;
  validUntil?: Date;
};

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a supplier offer into the normalized ConnectivityOffer2 table.
 *
 * This is the single entry point for all three ingestion paths. It:
 *   1. Calculates the customer price (wholesale + markup for supplier offers,
 *      direct price for own infrastructure).
 *   2. Creates/updates the ConnectivityOffer2 row.
 *   3. Returns the offer ID.
 *
 * Idempotency: if an offer with the same (tenantId, supplierId, spec, coverage)
 * already exists, it's updated rather than duplicated. This is important for
 * supplier feeds that are re-ingested periodically.
 */
export async function ingestOffer(input: IngestOfferInput): Promise<{ offerId: string; created: boolean }> {
  // Step 1: Calculate the customer price via the markup engine
  const markup = await calculateCustomerPrice({
    tenantId: input.tenantId,
    capabilityType: input.capabilityType,
    providerType: input.providerType,
    supplierId: input.supplierId ?? null,
    wholesalePriceMinor: input.wholesalePriceMinor,
  });

  // Step 2: Check for an existing offer (idempotency)
  const specJson = JSON.stringify(input.spec);
  const coverageJson = JSON.stringify(input.coverage);

  const existing = await db.connectivityOffer2.findFirst({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId ?? null,
      capabilityType: input.capabilityType,
      providerType: input.providerType,
      spec: specJson,
      coverage: coverageJson,
    },
  });

  if (existing) {
    // Update the existing offer (prices may have changed)
    const updated = await db.connectivityOffer2.update({
      where: { id: existing.id },
      data: {
        wholesalePriceMinor: input.wholesalePriceMinor,
        customerPriceMinor: markup.customerPriceMinor,
        currency: input.currency,
        validUntil: input.validUntil ?? null,
        status: "active",
      },
    });

    logger.info("offer.ingested_updated", {
      offerId: updated.id, tenantId: input.tenantId, supplierId: input.supplierId,
    });

    return { offerId: updated.id, created: false };
  }

  // Step 3: Create a new offer
  const offer = await db.connectivityOffer2.create({
    data: {
      tenantId: input.tenantId,
      capabilityType: input.capabilityType,
      providerType: input.providerType,
      spec: specJson,
      coverage: coverageJson,
      wholesalePriceMinor: input.wholesalePriceMinor,
      customerPriceMinor: markup.customerPriceMinor,
      currency: input.currency,
      supplierId: input.supplierId ?? null,
      status: "active",
      validUntil: input.validUntil ?? null,
    },
  });

  logger.info("offer.ingested_created", {
    offerId: offer.id, tenantId: input.tenantId, supplierId: input.supplierId,
    customerPriceMinor: markup.customerPriceMinor, source: markup.source,
  });

  return { offerId: offer.id, created: true };
}

// ---------------------------------------------------------------------------
// Convenience wrappers for the three ingestion paths
// ---------------------------------------------------------------------------

/**
 * Path 1: A WiFi operator publishes their own hotspot plan.
 * supplierId = null (the reseller IS the supplier).
 * The wholesalePriceMinor IS the customer price (no markup).
 */
export async function ingestOwnInfrastructure(input: {
  tenantId: string;
  capabilityType: string; // typically INTERNET
  providerType: string; // typically mikrotik
  spec: OfferSpec;
  coverage: OfferCoverage;
  customerPriceMinor: number;
  currency: string;
  validUntil?: Date;
}): Promise<{ offerId: string; created: boolean }> {
  return ingestOffer({
    tenantId: input.tenantId,
    capabilityType: input.capabilityType,
    providerType: input.providerType,
    spec: input.spec,
    coverage: input.coverage,
    // For own infrastructure, wholesale = customer (no markup)
    wholesalePriceMinor: input.customerPriceMinor,
    customerPriceMinor: input.customerPriceMinor,
    currency: input.currency,
    supplierId: null,
    validUntil: input.validUntil,
  } as IngestOfferInput & { customerPriceMinor: number });
}

/**
 * Path 2: An eSIM supplier's roaming product is imported.
 * supplierId = the eSIM supplier's ID.
 * The markup engine applies the reseller's markup to determine the customer price.
 */
export async function ingestSupplierFeed(input: {
  tenantId: string;
  supplierId: string;
  capabilityType: string; // typically ROAMING
  providerType: string; // typically esim
  spec: OfferSpec;
  coverage: OfferCoverage;
  wholesalePriceMinor: number;
  currency: string;
  validUntil?: Date;
}): Promise<{ offerId: string; created: boolean }> {
  return ingestOffer({
    tenantId: input.tenantId,
    capabilityType: input.capabilityType,
    providerType: input.providerType,
    spec: input.spec,
    coverage: input.coverage,
    wholesalePriceMinor: input.wholesalePriceMinor,
    currency: input.currency,
    supplierId: input.supplierId,
    validUntil: input.validUntil,
  });
}

/**
 * Path 3: A telco reseller imports a telecom product.
 * supplierId = the telco's ID.
 * The markup engine applies the reseller's markup.
 */
export async function ingestTelcoProduct(input: {
  tenantId: string;
  supplierId: string;
  capabilityType: string;
  providerType: string; // typically telco
  spec: OfferSpec;
  coverage: OfferCoverage;
  wholesalePriceMinor: number;
  currency: string;
  validUntil?: Date;
}): Promise<{ offerId: string; created: boolean }> {
  return ingestOffer({
    tenantId: input.tenantId,
    capabilityType: input.capabilityType,
    providerType: input.providerType,
    spec: input.spec,
    coverage: input.coverage,
    wholesalePriceMinor: input.wholesalePriceMinor,
    currency: input.currency,
    supplierId: input.supplierId,
    validUntil: input.validUntil,
  });
}
