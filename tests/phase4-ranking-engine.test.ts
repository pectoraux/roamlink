/**
 * Phase 4 — Reseller Operating System: Ranking Engine + Normalized Offers
 *
 * This suite proves:
 *   1. Supplier feed ingestion normalizes all three offer sources into
 *      ConnectivityOffer2 rows.
 *   2. The reseller markup engine applies the correct customer price.
 *   3. The offer ranking engine is deterministic — same inputs → same ranking.
 *   4. The ranking works across all three reseller types (WiFi operator,
 *      telco reseller, eSIM supplier) on a level playing field.
 *   5. The kernel is UNCHANGED (no entitlement/provisioning changes).
 *
 * Test matrix:
 *   A: Ingest WiFi operator's own infrastructure offer (supplierId = null)
 *   B: Ingest eSIM supplier feed offer (supplierId = supplier, markup applied)
 *   C: Ingest telco product (supplierId = telco, markup applied)
 *   D: Markup engine — global default + scoped override
 *   E: Ranking engine — deterministic (same inputs → same output)
 *   F: Ranking engine — filters by capability type
 *   G: Ranking engine — filters by budget
 *   H: Ranking engine — scores location match
 *   I: Ranking engine — scores reliability
 *   J: All three reseller types ranked on the same playing field
 *
 * Static:
 *   - Ranking engine is pure/deterministic (no randomness)
 *   - Kernel unchanged (entitlement.ts has no ranking code)
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import {
  seedConnectivityCapabilities,
  CAPABILITY_TYPES,
} from "@/lib/connectivity";
import {
  ingestOwnInfrastructure,
  ingestSupplierFeed,
  ingestTelcoProduct,
} from "@/lib/commerce/supplier-feed";
import { calculateCustomerPrice } from "@/lib/commerce/markup-engine";
import { rankOffers, DEFAULT_WEIGHTS } from "@/lib/commerce/ranking-engine";
import { hashPassword } from "@/lib/security";
import { createTenant, addTenantUser } from "@/lib/tenant/service";

let setupDone = false;
let tenantId: string;
let userId: string;
let supplierEsimId: string;
let supplierTelcoId: string;
const offerIds: string[] = [];
const markupIds: string[] = [];

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedConnectivityCapabilities();
  const user = await db.user.create({
    data: {
      email: `phase4-${Date.now()}@test.com`,
      name: "Phase 4 Test",
      passwordHash: await hashPassword("test12345"),
      role: "customer",
    },
  });
  userId = user.id;
  const tenant = await createTenant({ name: `Phase 4 ${Date.now()}` });
  tenantId = tenant.id;
  await addTenantUser({ tenantId, userId, role: "owner" });

  // Create supplier records (using the existing Supplier model)
  const esimSupplier = await db.supplier.create({
    data: { name: `eSIM Supplier ${Date.now()}`, type: "esim", active: true },
  });
  supplierEsimId = esimSupplier.id;

  const telcoSupplier = await db.supplier.create({
    data: { name: `Telco ${Date.now()}`, type: "telco", active: true },
  });
  supplierTelcoId = telcoSupplier.id;
}

afterAll(async () => {
  try {
    for (const oid of offerIds) await db.connectivityOffer2.deleteMany({ where: { id: oid } }).catch(() => {});
    for (const mid of markupIds) await db.resellerMarkup.deleteMany({ where: { id: mid } }).catch(() => {});
    await db.supplier.deleteMany({ where: { id: { in: [supplierEsimId, supplierTelcoId] } } }).catch(() => {});
    await db.connectivityIntent.deleteMany({ where: { tenantId } }).catch(() => {});
    await db.tenantUser.deleteMany({ where: { tenantId } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch (e) { console.error("afterAll:", e); }
  await db.$disconnect();
}, 180000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe("Phase 4 — Reseller Operating System: Ranking Engine + Normalized Offers", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  // -------------------------------------------------------------------------
  // A: Ingest WiFi operator's own infrastructure offer
  // -------------------------------------------------------------------------
  it("A: ingest WiFi operator's own infrastructure → ConnectivityOffer2 (no markup)", async () => {
    const result = await ingestOwnInfrastructure({
      tenantId,
      capabilityType: CAPABILITY_TYPES.INTERNET,
      providerType: "mikrotik",
      spec: { downloadMbps: 50, uploadMbps: 10 },
      coverage: { countries: ["GH"], cities: ["Accra"] },
      customerPriceMinor: 1500, // $15.00
      currency: "USD",
    });
    offerIds.push(result.offerId);

    expect(result.created).toBe(true);

    const offer = await db.connectivityOffer2.findUnique({ where: { id: result.offerId } });
    expect(offer).toBeTruthy();
    expect(offer!.supplierId).toBeNull(); // own infrastructure
    expect(offer!.wholesalePriceMinor).toBe(1500); // wholesale = customer (no markup)
    expect(offer!.customerPriceMinor).toBe(1500);
    expect(offer!.capabilityType).toBe("INTERNET");
    expect(offer!.providerType).toBe("mikrotik");
  }, 30000);

  // -------------------------------------------------------------------------
  // B: Ingest eSIM supplier feed offer
  // -------------------------------------------------------------------------
  it("B: ingest eSIM supplier feed → ConnectivityOffer2 (with markup)", async () => {
    // Set a markup for eSIM roaming
    const markup = await db.resellerMarkup.create({
      data: {
        tenantId,
        capabilityType: CAPABILITY_TYPES.ROAMING,
        providerType: "esim",
        supplierId: supplierEsimId,
        markupPercent: 20, // 20% markup
      },
    });
    markupIds.push(markup.id);

    const result = await ingestSupplierFeed({
      tenantId,
      supplierId: supplierEsimId,
      capabilityType: CAPABILITY_TYPES.ROAMING,
      providerType: "esim",
      spec: { dataLimitBytes: 5_000_000_000, validityDays: 30, allowedCountries: ["GH", "NG", "KE"] },
      coverage: { countries: ["GH", "NG", "KE"] },
      wholesalePriceMinor: 1000, // $10.00 wholesale
      currency: "USD",
    });
    offerIds.push(result.offerId);

    expect(result.created).toBe(true);

    const offer = await db.connectivityOffer2.findUnique({ where: { id: result.offerId } });
    expect(offer).toBeTruthy();
    expect(offer!.supplierId).toBe(supplierEsimId);
    expect(offer!.wholesalePriceMinor).toBe(1000);
    // 20% markup: 1000 * 1.2 = 1200
    expect(offer!.customerPriceMinor).toBe(1200);
  }, 30000);

  // -------------------------------------------------------------------------
  // C: Ingest telco product
  // -------------------------------------------------------------------------
  it("C: ingest telco product → ConnectivityOffer2 (with markup)", async () => {
    const markup = await db.resellerMarkup.create({
      data: {
        tenantId,
        capabilityType: CAPABILITY_TYPES.INTERNET,
        providerType: "telco",
        supplierId: supplierTelcoId,
        markupPercent: 15, // 15% markup
      },
    });
    markupIds.push(markup.id);

    const result = await ingestTelcoProduct({
      tenantId,
      supplierId: supplierTelcoId,
      capabilityType: CAPABILITY_TYPES.INTERNET,
      providerType: "telco",
      spec: { downloadMbps: 100, uploadMbps: 20, validityDays: 30 },
      coverage: { countries: ["GH"] },
      wholesalePriceMinor: 2000, // $20.00 wholesale
      currency: "USD",
    });
    offerIds.push(result.offerId);

    expect(result.created).toBe(true);

    const offer = await db.connectivityOffer2.findUnique({ where: { id: result.offerId } });
    expect(offer).toBeTruthy();
    expect(offer!.supplierId).toBe(supplierTelcoId);
    expect(offer!.wholesalePriceMinor).toBe(2000);
    // 15% markup: 2000 * 1.15 = 2300
    expect(offer!.customerPriceMinor).toBe(2300);
  }, 30000);

  // -------------------------------------------------------------------------
  // D: Markup engine — global default + scoped override
  // -------------------------------------------------------------------------
  it("D: markup engine resolves scoped rule over global default", async () => {
    // Set a global default markup (all nulls)
    const globalMarkup = await db.resellerMarkup.create({
      data: {
        tenantId,
        capabilityType: null,
        providerType: null,
        supplierId: null,
        markupPercent: 10, // 10% global default
      },
    });
    markupIds.push(globalMarkup.id);

    // An offer with no specific rule → uses global default
    const result1 = await calculateCustomerPrice({
      tenantId,
      capabilityType: "VPN_ACCESS",
      providerType: "future-vpn",
      supplierId: "some-future-supplier",
      wholesalePriceMinor: 1000,
    });
    expect(result1.markupPercent).toBe(10);
    expect(result1.customerPriceMinor).toBe(1100); // 1000 * 1.10
    expect(result1.source).toBe("global");

    // An offer with a specific rule → uses the specific rule (from test B)
    const result2 = await calculateCustomerPrice({
      tenantId,
      capabilityType: CAPABILITY_TYPES.ROAMING,
      providerType: "esim",
      supplierId: supplierEsimId,
      wholesalePriceMinor: 1000,
    });
    expect(result2.markupPercent).toBe(20); // scoped override
    expect(result2.customerPriceMinor).toBe(1200); // 1000 * 1.20
    expect(result2.source).toBe("capability+provider+supplier");
  }, 30000);

  // -------------------------------------------------------------------------
  // E: Ranking engine is deterministic (same inputs → same output)
  // -------------------------------------------------------------------------
  it("E: ranking engine is deterministic — same inputs produce same ranking", async () => {
    const intent = {
      tenantId,
      customerId: userId,
      capabilityType: CAPABILITY_TYPES.INTERNET,
    };

    const result1 = await rankOffers(intent, DEFAULT_WEIGHTS);
    const result2 = await rankOffers(intent, DEFAULT_WEIGHTS);

    // The ranked offer IDs must be identical
    const ids1 = result1.ranked.map((r) => r.offerId);
    const ids2 = result2.ranked.map((r) => r.offerId);
    expect(ids1).toEqual(ids2);

    // The scores must be identical
    const scores1 = result1.ranked.map((r) => r.score);
    const scores2 = result2.ranked.map((r) => r.score);
    expect(scores1).toEqual(scores2);
  }, 60000);

  // -------------------------------------------------------------------------
  // F: Ranking engine filters by capability type
  // -------------------------------------------------------------------------
  it("F: ranking engine filters by capability type", async () => {
    const result = await rankOffers({
      tenantId,
      customerId: userId,
      capabilityType: CAPABILITY_TYPES.ROAMING, // only eSIM offers
    });

    // All results must be ROAMING
    for (const ranked of result.ranked) {
      expect(ranked.offer.capabilityType).toBe("ROAMING");
    }
  }, 60000);

  // -------------------------------------------------------------------------
  // G: Ranking engine filters by budget
  // -------------------------------------------------------------------------
  it("G: ranking engine filters by budget", async () => {
    const result = await rankOffers({
      tenantId,
      customerId: userId,
      maxPriceMinor: 1500, // max $15.00
    });

    // All results must be <= 1500
    for (const ranked of result.ranked) {
      expect(ranked.customerPriceMinor).toBeLessThanOrEqual(1500);
    }
  }, 60000);

  // -------------------------------------------------------------------------
  // H: Ranking engine scores location match
  // -------------------------------------------------------------------------
  it("H: ranking engine scores location match — GH offers score higher for GH customer", async () => {
    const result = await rankOffers({
      tenantId,
      customerId: userId,
      location: { country: "GH" },
    });

    expect(result.ranked.length).toBeGreaterThan(0);

    // Offers covering GH should have locationMatch > 0.5
    const ghOffers = result.ranked.filter((r) => {
      const countries = r.offer.coverage.countries ?? [];
      return countries.includes("GH");
    });

    for (const ranked of ghOffers) {
      expect(ranked.scores.locationMatch).toBeGreaterThan(0.5);
    }
  }, 60000);

  // -------------------------------------------------------------------------
  // I: Ranking engine scores reliability
  // -------------------------------------------------------------------------
  it("I: ranking engine incorporates reliability score", async () => {
    // Create two offers with different reliability
    const highReliability = await ingestOwnInfrastructure({
      tenantId,
      capabilityType: CAPABILITY_TYPES.INTERNET,
      providerType: "mikrotik",
      spec: { downloadMbps: 50 },
      coverage: { countries: ["GH"] },
      customerPriceMinor: 1500,
      currency: "USD",
    });
    offerIds.push(highReliability.offerId);

    // Set high reliability
    await db.connectivityOffer2.update({
      where: { id: highReliability.offerId },
      data: { reliabilityScore: 0.95 },
    });

    const result = await rankOffers({
      tenantId,
      customerId: userId,
      capabilityType: CAPABILITY_TYPES.INTERNET,
    });

    // The high-reliability offer should be in the results
    const highRelRanked = result.ranked.find((r) => r.offerId === highReliability.offerId);
    expect(highRelRanked).toBeTruthy();
    expect(highRelRanked!.scores.reliability).toBe(0.95);
  }, 60000);

  // -------------------------------------------------------------------------
  // J: All three reseller types ranked on the same playing field
  // -------------------------------------------------------------------------
  it("J: all three reseller types (WiFi + eSIM + telco) ranked together", async () => {
    const result = await rankOffers({
      tenantId,
      customerId: userId,
      // No capability filter — all offers are eligible
    });

    // The results should include offers from multiple provider types
    const providerTypes = new Set(result.ranked.map((r) => r.offer.providerType));
    expect(providerTypes.size).toBeGreaterThanOrEqual(2); // at least 2 different types

    // The results should include both own-infra and supplier offers
    const hasOwnInfra = result.ranked.some((r) => r.offer.supplierId === null);
    const hasSupplier = result.ranked.some((r) => r.offer.supplierId !== null);
    expect(hasOwnInfra).toBe(true);
    expect(hasSupplier).toBe(true);

    // The ranking is sorted by score descending
    const scores = result.ranked.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }

    // Each ranked offer has all 6 score dimensions
    for (const ranked of result.ranked) {
      expect(ranked.scores).toHaveProperty("intentMatch");
      expect(ranked.scores).toHaveProperty("locationMatch");
      expect(ranked.scores).toHaveProperty("availability");
      expect(ranked.scores).toHaveProperty("price");
      expect(ranked.scores).toHaveProperty("margin");
      expect(ranked.scores).toHaveProperty("reliability");
    }
  }, 60000);

  // -------------------------------------------------------------------------
  // Static: ranking engine is deterministic (no randomness in source)
  // -------------------------------------------------------------------------
  it("Static: ranking engine contains no Math.random or Date.now in scoring", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ranking-engine.ts", "utf-8");
    // The scoring functions must not use randomness
    const scoringSection = source.substring(source.indexOf("// Scoring Functions"));
    expect(scoringSection).not.toContain("Math.random");
    // Date.now is allowed only for availability (current time check), not for scoring
    // Verify the score functions don't use Date.now
    const scoreFunctions = scoringSection.substring(0, scoringSection.indexOf("// Haversine"));
    // Date.now should not appear in the pure scoring functions
    expect(scoreFunctions).not.toContain("Date.now()");
  }, 10000);

  // -------------------------------------------------------------------------
  // Static: kernel unchanged (entitlement.ts has no ranking code)
  // -------------------------------------------------------------------------
  it("Static: kernel unchanged — entitlement.ts has no ranking/commerce code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("rankOffers");
    expect(source).not.toContain("ConnectivityOffer2");
    expect(source).not.toContain("ResellerMarkup");
    expect(source).not.toContain("calculateCustomerPrice");
    // The kernel still has the frozen functions
    expect(source).toContain("export async function provisionBinding");
    expect(source).toContain("export async function reconcileProvisioning");
  }, 10000);
});
