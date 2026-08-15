/**
 * Phase 6 — Business Layer Tests (Static)
 *
 * Static tests verifying the Phase 6 implementation:
 *   6.1: Reseller economics (earnings, costs, payouts, reconciliation)
 *   6.2: Marketplace completion (intent → purchase flow)
 *   6.3: Connectivity intelligence (deterministic intent parser)
 *   6.4: Operator onboarding (multi-step wizard)
 *   6.6: Analytics (reseller + platform)
 *
 * All tests are static (no DB) — they verify the code structure, not runtime
 * behavior. This keeps the test suite fast and independent of Neon latency.
 */

import { describe, expect, it } from "bun:test";
import { parseIntent, summarizeIntent } from "@/lib/commerce/intent-parser";

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe("Phase 6 — Business Layer (Static)", () => {
  // -------------------------------------------------------------------------
  // 6.1: Reseller Economics
  // -------------------------------------------------------------------------
  it("6.1.1: reseller-economics.ts exports earnings + costs + payouts functions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/reseller-economics.ts", "utf-8");
    expect(source).toContain("export async function calculateAndRecordEarnings");
    expect(source).toContain("export async function recordProviderCost");
    expect(source).toContain("export async function requestPayout");
    expect(source).toContain("export async function processPayout");
    expect(source).toContain("export async function getResellerBalance");
    expect(source).toContain("export async function settlePendingProviderCosts");
  });

  it("6.1.2: earnings are idempotent (upsert by orderId)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/reseller-economics.ts", "utf-8");
    expect(source).toContain("upsert");
    expect(source).toContain("where: { orderId: input.orderId }");
  });

  it("6.1.3: balance calculation includes earnings, costs, payouts", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/reseller-economics.ts", "utf-8");
    expect(source).toContain("totalEarningsMinor");
    expect(source).toContain("totalProviderCostsMinor");
    expect(source).toContain("pendingPayoutsMinor");
    expect(source).toContain("completedPayoutsMinor");
    expect(source).toContain("availableMinor");
  });

  it("6.1.4: fulfillment wires earnings + costs after ledger", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/fulfillment.ts", "utf-8");
    expect(source).toContain("calculateAndRecordEarnings");
    expect(source).toContain("recordProviderCost");
    expect(source).toContain("Phase 6.1: Record reseller earnings");
  });

  it("6.1.5: payout API exists and is auth-guarded", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/payouts/route.ts", "utf-8");
    expect(source).toContain("getCurrentUser");
    expect(source).toContain("requireTenantContext");
    expect(source).toContain("requestPayout");
  });

  it("6.1.6: reconciliation API uses CRON_SECRET", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/internal/reconcile-costs/route.ts", "utf-8");
    expect(source).toContain("CRON_SECRET");
    expect(source).toContain("settlePendingProviderCosts");
  });

  // -------------------------------------------------------------------------
  // 6.2: Marketplace Completion
  // -------------------------------------------------------------------------
  it("6.2.1: intent API parses + ranks + creates IntentRequest", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/intent/route.ts", "utf-8");
    expect(source).toContain("parseIntent");
    expect(source).toContain("rankOffers");
    expect(source).toContain("intentRequest.create");
    expect(source).toContain("status: \"ranked\"");
  });

  it("6.2.2: intent purchase API creates order + payment intent", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/intent/[intentId]/purchase/route.ts", "utf-8");
    expect(source).toContain("customerOrder.create");
    expect(source).toContain("createPaymentIntent");
    expect(source).toContain("resellerProduct.create");
    expect(source).toContain("status: \"purchased\"");
  });

  // -------------------------------------------------------------------------
  // 6.3: Connectivity Intelligence (deterministic intent parser)
  // -------------------------------------------------------------------------
  it("6.3.1: parseIntent extracts location from 'I need internet in Accra today'", () => {
    const result = parseIntent("I need internet in Accra today");
    expect(result.location?.city).toBe("Accra");
    expect(result.location?.country).toBe("GH");
    expect(result.capabilityType).toBe("INTERNET");
    expect(result.desiredSpec?.validityDays).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("6.3.2: parseIntent extracts roaming from 'cheap roaming for travel'", () => {
    const result = parseIntent("cheap roaming for travel");
    expect(result.capabilityType).toBe("ROAMING");
    expect(result.maxPriceMinor).toBe(1000); // "cheap" = $10
  });

  it("6.3.3: parseIntent extracts speed from '50Mbps WiFi monthly'", () => {
    const result = parseIntent("50Mbps WiFi monthly");
    expect(result.capabilityType).toBe("INTERNET");
    expect(result.desiredSpec?.downloadMbps).toBe(50);
    expect(result.desiredSpec?.validityDays).toBe(30);
  });

  it("6.3.4: parseIntent extracts data limit from '5GB eSIM for Nigeria'", () => {
    const result = parseIntent("5GB eSIM for Nigeria");
    expect(result.capabilityType).toBe("ROAMING");
    expect(result.desiredSpec?.dataLimitBytes).toBe(5_000_000_000);
    expect(result.location?.country).toBe("NG");
  });

  it("6.3.5: parseIntent extracts explicit budget from 'under $20 internet'", () => {
    const result = parseIntent("under $20 internet");
    expect(result.capabilityType).toBe("INTERNET");
    expect(result.maxPriceMinor).toBe(2000); // $20 = 2000 minor
  });

  it("6.3.6: parseIntent is deterministic (same input → same output)", () => {
    const input = "I need internet in Accra today";
    const result1 = parseIntent(input);
    const result2 = parseIntent(input);
    expect(result1).toEqual(result2);
  });

  it("6.3.7: summarizeIntent produces human-readable text", () => {
    const result = parseIntent("50Mbps internet in Accra monthly under $20");
    const summary = summarizeIntent(result);
    expect(summary).toContain("Internet");
    expect(summary).toContain("Accra");
    expect(summary).toContain("50Mbps");
  });

  it("6.3.8: intent parser has no Math.random", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/intent-parser.ts", "utf-8");
    expect(source).not.toContain("Math.random");
  });

  // -------------------------------------------------------------------------
  // 6.4: Operator Onboarding
  // -------------------------------------------------------------------------
  it("6.4.1: onboarding wizard has 4 steps", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/portal/onboarding/page.tsx", "utf-8");
    expect(source).toContain("Choose Type");
    expect(source).toContain("Connect Infrastructure");
    expect(source).toContain("Create Product");
    expect(source).toContain("Launch");
  });

  it("6.4.2: onboarding wizard supports wifi, telco, esim", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/portal/onboarding/page.tsx", "utf-8");
    expect(source).toContain("WiFi Operator");
    expect(source).toContain("Telco Reseller");
    expect(source).toContain("eSIM Reseller");
  });

  // -------------------------------------------------------------------------
  // 6.6: Analytics
  // -------------------------------------------------------------------------
  it("6.6.1: reseller analytics calculates revenue, profit, customers", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/analytics/reseller.ts", "utf-8");
    expect(source).toContain("getResellerAnalytics");
    expect(source).toContain("resellerEarning.aggregate");
    expect(source).toContain("revenue");
    expect(source).toContain("profit");
    expect(source).toContain("customerCount");
  });

  it("6.6.2: platform analytics calculates GMV, platform fees, provider exposure", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/analytics/platform.ts", "utf-8");
    expect(source).toContain("getPlatformAnalytics");
    expect(source).toContain("gmv");
    expect(source).toContain("platformFees");
    expect(source).toContain("providerExposure");
    expect(source).toContain("activeTenants");
  });

  it("6.6.3: analytics APIs are auth-guarded", async () => {
    const fs = await import("fs");
    const resellerSource = fs.readFileSync("src/app/api/analytics/reseller/route.ts", "utf-8");
    expect(resellerSource).toContain("getCurrentUser");
    expect(resellerSource).toContain("requireTenantContext");

    const platformSource = fs.readFileSync("src/app/api/analytics/platform/route.ts", "utf-8");
    expect(platformSource).toContain("requireAdmin");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: entitlement.ts is unchanged (no Phase 6 code)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("parseIntent");
    expect(source).not.toContain("ResellerEarning");
    expect(source).not.toContain("resellerPayout");
    expect(source).not.toContain("getResellerAnalytics");
    // The kernel still has its frozen functions
    expect(source).toContain("export async function provisionBinding");
    expect(source).toContain("export async function reconcileProvisioning");
  });

  it("KERNEL: ranking engine is unchanged (no Phase 6 code)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ranking-engine.ts", "utf-8");
    expect(source).not.toContain("parseIntent");
    expect(source).not.toContain("IntentRequest");
    // The ranking engine is still the frozen deterministic function
    expect(source).toContain("export async function rankOffers");
  });

  it("KERNEL: ledger is unchanged (no Phase 6 code)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/finance/double-entry-ledger.ts", "utf-8");
    expect(source).not.toContain("ResellerEarning");
    expect(source).not.toContain("ProviderCost");
    expect(source).not.toContain("ResellerPayout");
    // The ledger still has its frozen functions
    expect(source).toContain("export async function postLedgerTransaction");
    expect(source).toContain("export async function ledgerCustomerPayment");
  });
});
