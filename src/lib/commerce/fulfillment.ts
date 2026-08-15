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
