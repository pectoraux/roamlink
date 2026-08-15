/**
 * Phase 7 — Marketplace Reality: Static Tests
 *
 * Verifies:
 *   7.1: End-to-end business loop proof (static verification)
 *   7.2: Settlement (supplier + reseller)
 *   7.3: Operator success metrics (churn, best-selling, active users)
 *   7.4: AI intent extraction (structured only, ranking stays deterministic)
 *   7.6: Trust signals (ratings, uptime)
 *
 * All tests are static (no DB) — they verify code structure.
 * The end-to-end integration test (7.1) is also static because the full
 * loop requires DB + payment provider + webhook infrastructure.
 */

import { describe, expect, it } from "bun:test";

describe("Phase 7 — Marketplace Reality (Static)", () => {
  // -------------------------------------------------------------------------
  // 7.1: End-to-End Business Loop
  // -------------------------------------------------------------------------
  it("7.1.1: the full business loop is wired (signup → inventory → intent → purchase → payment → fulfill → costs → earnings → payout)", async () => {
    const fs = await import("fs");

    // Signup
    const onboarding = fs.readFileSync("src/app/api/onboarding/tenant/route.ts", "utf-8");
    expect(onboarding).toContain("db.user.create");
    expect(onboarding).toContain("createTenant");
    expect(onboarding).toContain("tenantSubscription.create");

    // Inventory (provider instance + product)
    const instances = fs.readFileSync("src/app/api/connectivity/instances/route.ts", "utf-8");
    expect(instances).toContain("createProviderInstance");

    const products = fs.readFileSync("src/app/api/commerce/products/route.ts", "utf-8");
    expect(products).toContain("resellerProduct.create");

    // Intent
    const intent = fs.readFileSync("src/app/api/commerce/intent/route.ts", "utf-8");
    expect(intent).toContain("extractIntentWithAI");
    expect(intent).toContain("rankOffers");

    // Purchase
    const purchase = fs.readFileSync("src/app/api/commerce/intent/[intentId]/purchase/route.ts", "utf-8");
    expect(purchase).toContain("customerOrder.create");
    expect(purchase).toContain("createPaymentIntent");

    // Payment webhook
    const webhook = fs.readFileSync("src/app/api/webhooks/commerce/[provider]/route.ts", "utf-8");
    expect(webhook).toContain("fulfillOrder");

    // Fulfillment (creates entitlement + provisions + posts ledger + records earnings)
    const fulfillment = fs.readFileSync("src/lib/commerce/fulfillment.ts", "utf-8");
    expect(fulfillment).toContain("createEntitlement");
    expect(fulfillment).toContain("provisionBinding");
    expect(fulfillment).toContain("postFulfillmentLedger");
    expect(fulfillment).toContain("calculateAndRecordEarnings");
    expect(fulfillment).toContain("recordProviderCost");

    // Payout
    const payouts = fs.readFileSync("src/app/api/commerce/payouts/route.ts", "utf-8");
    expect(payouts).toContain("requestPayout");
  });

  it("7.1.2: fulfillment links to all financial records", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/fulfillment.ts", "utf-8");
    // Ledger
    expect(source).toContain("ledgerCustomerPayment");
    expect(source).toContain("ledgerResellerPurchase");
    expect(source).toContain("ledgerPaymentFee");
    // Earnings
    expect(source).toContain("calculateAndRecordEarnings");
    // Provider costs
    expect(source).toContain("recordProviderCost");
  });

  // -------------------------------------------------------------------------
  // 7.2: Settlement
  // -------------------------------------------------------------------------
  it("7.2.1: settlement service exists with supplier + reseller functions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/settlement.ts", "utf-8");
    expect(source).toContain("createSupplierSettlement");
    expect(source).toContain("generateSupplierInvoice");
    expect(source).toContain("settleSupplierInvoice");
    expect(source).toContain("getResellerSettlementSummary");
  });

  it("7.2.2: supplier settlement aggregates ProviderCost records", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/settlement.ts", "utf-8");
    expect(source).toContain("providerCost.findMany");
    expect(source).toContain("status: \"pending\"");
    expect(source).toContain("supplierSettlement.create");
    expect(source).toContain("status: \"settled\"");
  });

  it("7.2.3: settlement API is auth-guarded", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/settlements/route.ts", "utf-8");
    expect(source).toContain("getCurrentUser");
    expect(source).toContain("requireTenantContext");
  });

  // -------------------------------------------------------------------------
  // 7.3: Operator Success Metrics
  // -------------------------------------------------------------------------
  it("7.3.1: analytics includes churn rate", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/analytics/reseller.ts", "utf-8");
    expect(source).toContain("churnRate");
    expect(source).toContain("churnedCustomers");
  });

  it("7.3.2: analytics includes best-selling offers", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/analytics/reseller.ts", "utf-8");
    expect(source).toContain("bestSellingOffers");
    expect(source).toContain("groupBy");
    expect(source).toContain("paidAmountMinor");
  });

  it("7.3.3: analytics includes active users trend", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/analytics/reseller.ts", "utf-8");
    expect(source).toContain("activeUsersPerDay");
    expect(source).toContain("usersByDay");
  });

  it("7.3.4: analytics includes ratings + uptime", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/analytics/reseller.ts", "utf-8");
    expect(source).toContain("avgRating");
    expect(source).toContain("uptimePercent");
    expect(source).toContain("offerRating.aggregate");
    expect(source).toContain("uptimeMeasurement");
  });

  // -------------------------------------------------------------------------
  // 7.4: AI Intent Extraction
  // -------------------------------------------------------------------------
  it("7.4.1: AI intent extraction exists and uses z-ai-web-dev-sdk", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ai-intent.ts", "utf-8");
    expect(source).toContain("z-ai-web-dev-sdk");
    expect(source).toContain("extractIntentWithAI");
    expect(source).toContain("chat.completions.create");
  });

  it("7.4.2: AI extraction produces structured output only (no ranking)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ai-intent.ts", "utf-8");
    // The AI produces a ParsedIntent JSON — NOT a ranked list
    expect(source).toContain("ParsedIntent");
    expect(source).toContain("capabilityType");
    expect(source).toContain("desiredSpec");
    expect(source).toContain("location");
    expect(source).toContain("maxPriceMinor");
    // The AI does NOT call the rankOffers function (only mentions it in comments)
    expect(source).not.toContain("await rankOffers");
    expect(source).not.toContain("import { rankOffers");
    expect(source).not.toContain("from \"./ranking-engine\"");
  });

  it("7.4.3: AI extraction falls back to deterministic parser on failure", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ai-intent.ts", "utf-8");
    expect(source).toContain("parseIntent(rawText)"); // fallback
    expect(source).toContain("Fallback to deterministic parser");
  });

  it("7.4.4: intent API uses AI extraction first", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/intent/route.ts", "utf-8");
    expect(source).toContain("extractIntentWithAI");
    expect(source).toContain("rankOffers"); // ranking is still deterministic
  });

  it("7.4.5: ranking engine is unchanged (no AI code)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ranking-engine.ts", "utf-8");
    expect(source).not.toContain("z-ai-web-dev-sdk");
    expect(source).not.toContain("extractIntentWithAI");
    expect(source).toContain("export async function rankOffers"); // still deterministic
  });

  // -------------------------------------------------------------------------
  // 7.6: Trust Signals
  // -------------------------------------------------------------------------
  it("7.6.1: offer rating API exists and is auth-guarded", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/orders/[orderId]/rate/route.ts", "utf-8");
    expect(source).toContain("getCurrentUser");
    expect(source).toContain("requireTenantContext");
    expect(source).toContain("offerRating.upsert");
    expect(source).toContain("orderId"); // idempotent
  });

  it("7.6.2: uptime measurement cron uses CRON_SECRET", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/internal/measure-uptime/route.ts", "utf-8");
    expect(source).toContain("CRON_SECRET");
    expect(source).toContain("uptimeMeasurement.create");
    expect(source).toContain("isReachable");
  });

  it("7.6.3: ConnectivityOffer2 has reliability fields", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(source).toContain("reliabilityScore");
    expect(source).toContain("successCount");
    expect(source).toContain("failureCount");
    expect(source).toContain("lastProvisionedAt");
    expect(source).toContain("lastFailedAt");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: entitlement.ts has no Phase 7 code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("SupplierSettlement");
    expect(source).not.toContain("OfferRating");
    expect(source).not.toContain("UptimeMeasurement");
    expect(source).not.toContain("extractIntentWithAI");
    expect(source).toContain("export async function provisionBinding");
  });

  it("KERNEL: ranking engine has no Phase 7 code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ranking-engine.ts", "utf-8");
    expect(source).not.toContain("SupplierSettlement");
    expect(source).not.toContain("OfferRating");
    expect(source).not.toContain("z-ai-web-dev-sdk");
    expect(source).toContain("export async function rankOffers");
  });

  it("KERNEL: ledger has no Phase 7 code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/finance/double-entry-ledger.ts", "utf-8");
    expect(source).not.toContain("SupplierSettlement");
    expect(source).not.toContain("OfferRating");
    expect(source).toContain("export async function postLedgerTransaction");
  });
});
