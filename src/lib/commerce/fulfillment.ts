/**
 * Phase 3 — Fulfillment Service
 *
 * The thin commercial layer connecting CustomerOrder to the frozen entitlement
 * kernel. This is the ONLY new service code that touches both the commercial
 * entities (ResellerProduct, CustomerOrder) and the frozen kernel
 * (createEntitlement, createResourceBinding, provisionBinding).
 *
 * Flow:
 *   1. CustomerOrder is created (status: pending)
 *   2. Payment is confirmed (status: paid) — handled by the payment route
 *   3. fulfillOrder() is called:
 *      a. Look up the ResellerProduct
 *      b. createEntitlement() — frozen kernel
 *      c. transitionEntitlement() → ACTIVE — frozen kernel
 *      d. createResourceBinding() — frozen kernel
 *      e. provisionBinding() — frozen kernel (creates the resource at the provider)
 *      f. Extract credentials from the binding
 *      g. Update CustomerOrder (status: fulfilled, entitlementId, credentials)
 *   4. If any step fails, the order is marked failed and the entitlement
 *      remains in a recoverable state (reconcileProvisioning can retry).
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  createEntitlement,
  transitionEntitlement,
  createResourceBinding,
  provisionBinding,
  ENTITLEMENT_STATES,
} from "@/lib/connectivity";
import type { CapabilityType } from "@/lib/connectivity";
import {
  ledgerCustomerPayment,
  ledgerResellerPurchase,
  ledgerPaymentFee,
} from "@/lib/finance/double-entry-ledger";
import { calculateAndRecordEarnings, recordProviderCost } from "@/lib/commerce/reseller-economics";

export type FulfillmentResult = {
  status: "fulfilled" | "failed";
  orderId: string;
  entitlementId?: string;
  providerResourceId?: string;
  credentials?: Record<string, unknown>;
  error?: string;
};

export async function fulfillOrder(orderId: string): Promise<FulfillmentResult> {
  const order = await db.customerOrder.findUnique({
    where: { id: orderId },
    include: { product: true },
  });

  if (!order) {
    return { status: "failed", orderId, error: "Order not found" };
  }

  if (order.status !== "paid") {
    return { status: "failed", orderId, error: `Order status is "${order.status}", expected "paid"` };
  }

  const product = order.product;
  logger.info("fulfillment.starting", { orderId, productId: product.id, tenantId: order.tenantId });

  try {
    const subscription = await db.tenantSubscription.findFirst({
      where: { tenantId: order.tenantId, status: "active" },
    });

    if (!subscription) {
      throw new Error(`No active subscription for tenant ${order.tenantId}`);
    }

    const capabilitySet = JSON.parse(product.capabilitySet);
    const entitlement = await createEntitlement({
      tenantId: order.tenantId,
      subscriptionId: subscription.id,
      capabilityType: product.capabilityType as CapabilityType,
      capabilitySet,
      validFrom: new Date(),
      userId: order.customerId,
    });

    logger.info("fulfillment.entitlement_created", { orderId, entitlementId: entitlement.id });

    await transitionEntitlement({
      entitlementId: entitlement.id,
      toState: ENTITLEMENT_STATES.ACTIVE,
    });

    let providerInstanceId: string | undefined;
    if (product.providerType) {
      const instance = await db.connectivityProviderInstance.findFirst({
        where: { tenantId: order.tenantId, providerType: product.providerType, status: "active" },
      });
      if (!instance) {
        throw new Error(`No active ${product.providerType} provider instance for tenant ${order.tenantId}`);
      }
      providerInstanceId = instance.id;
    }

    const resourceType = product.providerType === "esim" ? "esim_profile" : "hotspot_user";
    const binding = await createResourceBinding({
      entitlementId: entitlement.id,
      providerType: product.providerType ?? "mikrotik",
      resourceType,
      providerInstanceId,
      userId: order.customerId,
    });

    logger.info("fulfillment.binding_created", { orderId, bindingId: binding.id });

    const provisionResult = await provisionBinding(binding.id);

    if (provisionResult.status !== "success" && provisionResult.status !== "already_provisioned") {
      throw new Error(`Provisioning failed: ${provisionResult.status} — ${provisionResult.error}`);
    }

    const bindingAfter = await db.providerResourceBinding.findUnique({
      where: { id: binding.id },
      select: { providerResourceId: true, providerMetadata: true },
    });

    const credentials = extractCredentials(
      product.providerType ?? "mikrotik",
      bindingAfter?.providerResourceId ?? undefined,
      bindingAfter?.providerMetadata ? JSON.parse(bindingAfter.providerMetadata) : null,
    );

    await db.customerOrder.update({
      where: { id: orderId },
      data: {
        status: "fulfilled",
        entitlementId: entitlement.id,
        credentials: JSON.stringify(credentials),
      },
    });

    // Phase 5.1B: Post ledger entries for financial truth.
    // Every fulfilled order records:
    //   1. Customer payment (cash received, revenue recognized)
    //   2. Payment processing fee (provider liability)
    //   3. Reseller purchase (connectivity revenue net of platform fee)
    // All ledger calls are idempotent via the orderId-based idempotency key.
    await postFulfillmentLedger({
      tenantId: order.tenantId,
      orderId: order.id,
      customerId: order.customerId,
      customerPriceMinor: order.paidAmountMinor,
      wholesalePriceMinor: product.priceMinor, // for own infra, wholesale = customer
      currency: order.currency,
      paymentProvider: order.paymentRef?.startsWith("sim-") ? "mock" : "paystack",
      paymentRef: order.paymentRef ?? undefined,
    });

    logger.info("fulfillment.completed", {
      orderId, entitlementId: entitlement.id, providerResourceId: provisionResult.providerResourceId,
    });

    return {
      status: "fulfilled",
      orderId,
      entitlementId: entitlement.id,
      providerResourceId: provisionResult.providerResourceId,
      credentials,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("fulfillment.failed", { orderId, error: errorMsg });

    await db.customerOrder.update({
      where: { id: orderId },
      data: { status: "failed" },
    }).catch(() => {});

    return { status: "failed", orderId, error: errorMsg };
  }
}

function extractCredentials(
  providerType: string,
  providerResourceId: string | undefined,
  providerMetadata: Record<string, unknown> | null,
): Record<string, unknown> {
  const creds: Record<string, unknown> = {};

  if (providerResourceId) {
    creds.providerResourceId = providerResourceId;
  }

  if (providerType === "mikrotik") {
    creds.hotspotUsername = providerResourceId;
    creds.instructions = "Use this username with the password provided separately to connect to the WiFi.";
  } else if (providerType === "esim") {
    creds.iccid = providerResourceId;
    creds.instructions = "Use this ICCID to activate your eSIM profile on your device.";
  }

  if (providerMetadata) {
    creds.metadata = providerMetadata;
  }

  return creds;
}

// ---------------------------------------------------------------------------
// Phase 5.1B: Ledger Integration
// ---------------------------------------------------------------------------

/**
 * Post ledger entries for a fulfilled order.
 *
 * This connects the commerce layer to the existing double-entry ledger
 * (src/lib/finance/double-entry-ledger.ts). Every fulfilled order records:
 *
 *   1. Customer payment — the cash received from the customer
 *   2. Payment processing fee — the fee charged by the payment provider
 *   3. Reseller purchase — the connectivity revenue net of platform fee
 *
 * The contribution margin (customerPrice - wholesalePrice - paymentFee) is
 * implicitly captured: customer payment credits revenue, payment fee debits
 * fees, and the reseller purchase entry separates platform fee from
 * connectivity revenue.
 *
 * All entries are idempotent via orderId-based idempotency keys. If
 * fulfillOrder() is retried (e.g., after a crash), the ledger entries are
 * not duplicated.
 */
async function postFulfillmentLedger(input: {
  tenantId: string;
  orderId: string;
  customerId: string;
  customerPriceMinor: number;
  wholesalePriceMinor: number;
  currency: string;
  paymentProvider: string;
  paymentRef?: string;
}): Promise<void> {
  // Estimate the payment processing fee (typically 1.5–3.5% depending on provider)
  // Paystack: 1.5% (local), 3.8% (international)
  // Stripe: 2.9% + 30¢
  // Mock: 0%
  const feePercent = input.paymentProvider === "mock" ? 0 : 0.015; // 1.5% default
  const paymentFeeMinor = Math.round(input.customerPriceMinor * feePercent);

  const idempotencyBase = `commerce-${input.orderId}`;

  try {
    // 1. Customer payment (cash received, revenue recognized)
    await ledgerCustomerPayment({
      userId: input.customerId,
      orderId: input.orderId,
      customerPriceMinor: input.customerPriceMinor,
      paymentFeeMinor,
      currency: input.currency,
      provider: input.paymentProvider,
      providerTxnId: input.paymentRef,
      idempotencyKey: `${idempotencyBase}-customer-payment`,
    });

    // 2. Payment processing fee (separate entry for fee tracking)
    if (paymentFeeMinor > 0) {
      await ledgerPaymentFee({
        userId: input.customerId,
        orderId: input.orderId,
        paymentFeeMinor,
        currency: input.currency,
        provider: input.paymentProvider,
        idempotencyKey: `${idempotencyBase}-payment-fee`,
      });
    }

    // 3. Reseller purchase (connectivity revenue net of platform fee)
    // The platform fee is a percentage of the transaction (from SaaasPlan.platformFeePercent)
    const subscription = await db.tenantSubscription.findFirst({
      where: { tenantId: input.tenantId, status: "active" },
      include: { saaasPlan: { select: { platformFeePercent: true } } },
    });

    const platformFeePercent = subscription?.saaasPlan.platformFeePercent ?? 0;
    const platformFeeMinor = Math.round(input.customerPriceMinor * (platformFeePercent / 100));

    await ledgerResellerPurchase({
      tenantId: input.tenantId,
      userId: input.customerId,
      orderId: input.orderId,
      retailPriceMinor: input.customerPriceMinor,
      platformFeeMinor,
      reason: `Connectivity purchase — order ${input.orderId}`,
      currency: input.currency,
      idempotencyKey: `${idempotencyBase}-reseller-purchase`,
    });

    logger.info("fulfillment.ledger_posted", {
      orderId: input.orderId,
      customerPriceMinor: input.customerPriceMinor,
      paymentFeeMinor,
      platformFeeMinor,
      contributionMarginMinor: input.customerPriceMinor - input.wholesalePriceMinor - paymentFeeMinor,
    });

    // Phase 6.1: Record reseller earnings + provider costs (commercial view)
    // These are idempotent and link to the ledger entries above.
    await calculateAndRecordEarnings({
      tenantId: input.tenantId,
      orderId: input.orderId,
      customerPaymentMinor: input.customerPriceMinor,
      wholesaleCostMinor: input.wholesalePriceMinor,
      paymentFeeMinor,
      platformFeeMinor,
      currency: input.currency,
    });

    // Record provider cost for supplier offers (eSIM, telco).
    // For own infrastructure (supplierId = null), no cost is recorded.
    // NOTE: supplierId would come from the ConnectivityOffer2 if this order
    // was placed from a ranked offer. For now, we pass undefined — the
    // recordProviderCost function skips if supplierId is null/undefined.
    if (input.wholesalePriceMinor > 0) {
      await recordProviderCost({
        tenantId: input.tenantId,
        orderId: input.orderId,
        wholesaleCostMinor: input.wholesalePriceMinor,
        currency: input.currency,
      }).catch((err) => {
        logger.error("fulfillment.provider_cost_failed", {
          orderId: input.orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    // Ledger failures are logged but don't fail the fulfillment — the
    // customer's resource is already provisioned. The ledger can be
    // reconciled separately. This follows the same pattern as the SaaS
    // billing kernel: provisioning success is not rolled back on ledger failure.
    logger.error("fulfillment.ledger_failed", {
      orderId: input.orderId,
      error: err instanceof Error ? err.message : String(err),
      message: "CRITICAL: Ledger posting failed. The order is fulfilled but financial truth is incomplete. Manual reconciliation required.",
    });
  }
}
