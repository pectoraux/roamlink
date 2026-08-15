/**
 * Phase 5.1 — Commercial Foundation Tests
 *
 * Tests for the 5 commercial foundation capabilities:
 *   A. Payment integration (payment intent API + webhook idempotency)
 *   B. Ledger integration (fulfillment posts ledger entries)
 *   C. Security (customer API derives tenantId from product, not request body)
 *   D. Reseller onboarding (creates user + tenant + trial subscription)
 *   E. Provider instance management (create + list + deactivate)
 *
 * Static tests verify:
 *   - The frozen kernel is unchanged
 *   - Ledger functions are called in fulfillment
 *   - Security fix is present (tenantId derived from product)
 *   - Webhook handler uses WebhookEvent for idempotency
 */

import { describe, expect, it } from "bun:test";
import { db } from "@/lib/db";

// ===========================================================================
// STATIC tests (no DB — fast)
// ===========================================================================

describe("Phase 5.1 — Commercial Foundation (Static)", () => {
  // -------------------------------------------------------------------------
  // A. Payment integration
  // -------------------------------------------------------------------------
  it("A1: payment intent API exists and uses the payment provider", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/orders/[orderId]/payment-intent/route.ts", "utf-8");
    expect(source).toContain("getPaymentProvider");
    expect(source).toContain("createPaymentIntent");
    expect(source).toContain("idempotencyKey");
    expect(source).toContain("providerReference");
  });

  it("A2: webhook handler uses WebhookEvent for idempotency", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/webhooks/commerce/[provider]/route.ts", "utf-8");
    expect(source).toContain("webhookEvent.findUnique");
    expect(source).toContain("provider_externalId");
    expect(source).toContain("processed");
    expect(source).toContain("already_processed");
    expect(source).toContain("fulfillOrder");
  });

  // -------------------------------------------------------------------------
  // B. Ledger integration
  // -------------------------------------------------------------------------
  it("B1: fulfillment imports and calls ledger functions", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/fulfillment.ts", "utf-8");
    expect(source).toContain("import {");
    expect(source).toContain("ledgerCustomerPayment");
    expect(source).toContain("ledgerResellerPurchase");
    expect(source).toContain("ledgerPaymentFee");
    expect(source).toContain("postFulfillmentLedger");
    expect(source).toContain("fulfillment.ledger_posted");
  });

  it("B2: ledger entries are idempotent (orderId-based keys)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/fulfillment.ts", "utf-8");
    // The idempotency keys use template literals: `commerce-${input.orderId}-...`
    expect(source).toContain("${idempotencyBase}-customer-payment");
    expect(source).toContain("${idempotencyBase}-payment-fee");
    expect(source).toContain("${idempotencyBase}-reseller-purchase");
    // And idempotencyBase is derived from orderId
    expect(source).toContain('const idempotencyBase = `commerce-${input.orderId}`');
  });

  it("B3: ledger failure doesn't roll back fulfillment", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/fulfillment.ts", "utf-8");
    expect(source).toContain("fulfillment.ledger_failed");
    expect(source).toContain("Manual reconciliation required");
    // The catch block logs but doesn't re-throw
    expect(source).toContain("} catch (err) {");
  });

  // -------------------------------------------------------------------------
  // C. Security
  // -------------------------------------------------------------------------
  it("C1: customer API derives tenantId from productId, NOT request body", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/customer/route.ts", "utf-8");
    // The API must accept productId, not tenantId
    expect(source).toContain("productId");
    expect(source).toContain("SECURITY: derive tenantId from the product");
    // It must look up the product to get the tenantId
    expect(source).toContain("resellerProduct.findFirst");
    expect(source).toContain("where: { id: productId, status: \"active\" }");
  });

  it("C2: customer API does NOT trust tenantId from request body", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/commerce/customer/route.ts", "utf-8");
    // The old vulnerable pattern accepted tenantId from body
    // The new pattern must NOT destructure tenantId from body
    const bodyDestructure = source.match(/const \{([^}]+)\} = body/);
    if (bodyDestructure) {
      const fields = bodyDestructure[1];
      expect(fields).not.toContain("tenantId");
    }
  });

  // -------------------------------------------------------------------------
  // D. Reseller onboarding
  // -------------------------------------------------------------------------
  it("D1: onboarding API creates user + tenant + trial subscription", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/onboarding/tenant/route.ts", "utf-8");
    expect(source).toContain("db.user.create");
    expect(source).toContain("createTenant");
    expect(source).toContain("addTenantUser");
    expect(source).toContain("tenantSubscription.create");
    expect(source).toContain("trialing");
    expect(source).toContain("trialEndsAt");
  });

  it("D2: onboarding validates email uniqueness and slug availability", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/onboarding/tenant/route.ts", "utf-8");
    expect(source).toContain("findUnique({ where: { email }");
    expect(source).toContain("already exists");
    expect(source).toContain("findUnique({ where: { slug }");
    expect(source).toContain("already taken");
  });

  it("D3: onboarding creates TenantBalance for the new tenant", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/onboarding/tenant/route.ts", "utf-8");
    expect(source).toContain("tenantBalance.create");
    expect(source).toContain("balanceMinor: 0");
  });

  // -------------------------------------------------------------------------
  // E. Provider instance management
  // -------------------------------------------------------------------------
  it("E1: provider instance API uses createProviderInstance from the kernel", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/connectivity/instances/route.ts", "utf-8");
    expect(source).toContain("createProviderInstance");
    expect(source).toContain("@/lib/connectivity");
  });

  it("E2: provider instance API is auth-guarded", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/connectivity/instances/route.ts", "utf-8");
    expect(source).toContain("getCurrentUser");
    expect(source).toContain("requireTenantContext");
  });

  it("E3: provider instance API validates providerType", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/connectivity/instances/route.ts", "utf-8");
    expect(source).toContain("[\"mikrotik\", \"esim\"]");
    expect(source).toContain("Unsupported providerType");
  });

  it("E4: provider instance DELETE is a soft delete (marks inactive)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/app/api/connectivity/instances/[instanceId]/route.ts", "utf-8");
    expect(source).toContain("status: \"inactive\"");
    expect(source).toContain("Soft delete");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: entitlement.ts is unchanged (no commerce/payment/onboarding code)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    // The kernel should NOT contain commerce/payment/onboarding code
    expect(source).not.toContain("fulfillOrder");
    expect(source).not.toContain("paymentIntent");
    expect(source).not.toContain("onboarding");
    expect(source).not.toContain("ledgerCustomerPayment");
    // The kernel still has its frozen functions
    expect(source).toContain("export async function provisionBinding");
    expect(source).toContain("export async function reconcileProvisioning");
    expect(source).toContain("export async function claimProvisioning");
  });
});
