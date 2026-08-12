/**
 * Order service — orchestrates the purchase flow.
 *
 *   PLAN_SELECTED -> CHECKOUT_CREATED -> PAYMENT_PENDING -> PAYMENT_CONFIRMED
 *     -> ESIM_PROVISIONING -> ESIM_PROVISIONED -> COMPLETED
 *
 * Phase 2C — Connectivity Orchestration Convergence:
 *
 *   1. createOrder resolves the canonical ConnectivityProduct (by sourcePlanId)
 *      and the DistributionOffer for (product, tenant). The retail price is
 *      FROZEN from the DistributionOffer at checkout time — it never depends
 *      on which supplier will eventually fulfill the order.
 *
 *   2. confirmAndProvision verifies payment (existing hardening) then calls
 *      fulfillOrder(), which runs the orchestrator, picks a supplier offer,
 *      reserves provider credit, provisions via the FulfillmentAdapter,
 *      persists via the FulfillmentPersistenceHandler, settles the credit
 *      reservation, and finalizes the commercial transaction in the double-
 *      entry ledger.
 *
 * Critical business rules enforced here:
 *   - Rule 1/2: eSIM is NEVER provisioned because the frontend says payment
 *     succeeded. Payment is verified server-side.
 *   - Rule 3: An order can only provision once (1:1 order->esim, DB unique).
 *   - Rule 6: Provider data isolated behind adapters.
 *   - Rule 9: Wholesale pricing never exposed (PublicPlan strips it).
 *   - Phase 2C: The supplier never determines the tenant's retail price.
 */

import { db } from "@/lib/db";
import { getESIMProvider } from "@/lib/esim";
import { getPaymentProvider } from "@/lib/payments";
import { getCanonicalPlan } from "@/lib/plans/service";
import { assertTransition } from "./state-machine";
import {
  canTransitionFulfillment,
  transitionFulfillment,
  getFulfillmentStatus,
  type FulfillmentStatus,
} from "./fulfillment-state-machine";
import { generateIdempotencyKey, audit } from "./idempotency";
import { logger } from "@/lib/logger";
import { AppError, classifyProviderError } from "@/lib/errors";
import { recordProviderResult } from "@/lib/providers/routing";
import { computeProductIdentity } from "@/lib/catalog/identity";
import { selectSupplierForProduct } from "@/lib/orchestration/engine";
import {
  resolveProviderKey,
  getAdapter,
  getPersistenceHandler,
  type FulfillmentContext,
} from "@/lib/fulfillment/adapter";
// Side-effect import: ensures default adapters + persistence are registered.
import "@/lib/fulfillment/registry";
import {
  reserveProviderCommitment,
  settleReservation,
  releaseReservation,
  ensureProviderAccount,
} from "@/lib/finance/provider-credit";
import { finalizeCommercialTransaction } from "@/lib/finance/finalize";
import type { OrderStatus } from "@/types";
import type { Currency } from "@/lib/money";

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

export type OrderSnapshot = {
  id: string;
  status: OrderStatus;
  amountMinor: number;
  currency: string;
  paymentStatus: string;
  paymentProvider: string | null;
  paymentReference: string | null;
  providerOrderId: string | null;
  planId: string;
  planName: string;
  country: string;
  countryCode: string;
  dataAmountMB: number;
  validityDays: number;
  esimId: string | null;
  failureReason: string | null;
  // Phase 2C additions
  tenantId: string | null;
  fulfillmentStatus: FulfillmentStatus;
  financialStatus: string;
  distributionOfferId: string | null;
  canonicalProductId: string | null;
  supplierOfferId: string | null;
  createdAt: string;
  updatedAt: string;
};

type OrderWithIncludes = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  paymentProvider: string | null;
  paymentReference: string | null;
  providerOrderId: string | null;
  planId: string | null;
  planSnapshot: string | null;
  failureReason: string | null;
  tenantId: string | null;
  fulfillmentStatus: string;
  financialStatus: string;
  fulfillmentExternalReference: string | null;
  fulfillmentEntityId: string | null;
  supplierOfferId: string | null;
  createdAt: Date;
  updatedAt: Date;
  plan: {
    id: string;
    name: string;
    country: string;
    countryCode: string;
    dataAmount: number;
    validityDays: number;
  } | null;
  esim: { id: string } | null;
};

function toSnapshot(o: OrderWithIncludes): OrderSnapshot {
  const snapshot = parseOrderSnapshot(o.planSnapshot);
  return {
    id: o.id,
    status: o.status as OrderStatus,
    amountMinor: o.amount,
    currency: o.currency,
    paymentStatus: o.paymentStatus,
    paymentProvider: o.paymentProvider,
    paymentReference: o.paymentReference,
    providerOrderId: o.providerOrderId,
    planId: o.planId ?? "",
    planName: o.plan?.name ?? "",
    country: o.plan?.country ?? "",
    countryCode: o.plan?.countryCode ?? "",
    dataAmountMB: o.plan?.dataAmount ?? 0,
    validityDays: o.plan?.validityDays ?? 0,
    esimId: o.esim?.id ?? null,
    failureReason: o.failureReason,
    tenantId: o.tenantId,
    fulfillmentStatus: o.fulfillmentStatus as FulfillmentStatus,
    financialStatus: o.financialStatus,
    distributionOfferId: snapshot.distributionOfferId ?? null,
    canonicalProductId: snapshot.canonicalProductId ?? null,
    supplierOfferId: o.supplierOfferId,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

/**
 * Read canonical-product / distribution-offer fields from the order's
 * planSnapshot JSON. These are captured at checkout time and frozen.
 */
function parseOrderSnapshot(raw: string | null): OrderSnapshotParsed {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as OrderSnapshotParsed;
  } catch {
    return {};
  }
}

type OrderSnapshotParsed = {
  canonicalProductId?: string;
  canonicalSpecification?: string | null;
  identityHash?: string | null;
  productType?: string;
  distributionOfferId?: string;
  retailPriceMinor?: number;
  tenantId?: string | null;
};

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

/**
 * Find or create the canonical ConnectivityProduct for a Plan.
 * The Plan's `id` becomes the ConnectivityProduct's `sourcePlanId`.
 */
async function ensureConnectivityProductForPlan(plan: {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  region: string;
  dataAmount: number;
  validityDays: number;
}): Promise<{ id: string; identityHash: string | null; canonicalSpecification: string | null; type: string }> {
  // 1. Look up by sourcePlanId (the Plan that originated this product).
  const existing = await db.connectivityProduct.findUnique({
    where: { sourcePlanId: plan.id },
  });
  if (existing) {
    return {
      id: existing.id,
      identityHash: existing.identityHash,
      canonicalSpecification: existing.canonicalSpecification,
      type: existing.type,
    };
  }

  // 2. Compute the canonical identity.
  const identity = computeProductIdentity({
    type: "ESIM",
    name: plan.name,
    country: plan.country,
    countryCode: plan.countryCode,
    region: plan.region,
    dataAmountMB: plan.dataAmount,
    validityDays: plan.validityDays,
    capabilities: ["DATA", "ESIM"],
  });

  // 3. Look up by identityHash — supplier convergence path.
  // If a product with the same canonical identity already exists (from a
  // different supplier's plan), reuse it rather than creating a duplicate.
  const converged = await db.connectivityProduct.findFirst({
    where: { identityHash: identity.identityHash },
  });
  if (converged) {
    logger.info("catalog.product.converged", {
      productId: converged.id,
      identityHash: identity.identityHash,
      sourcePlanId: plan.id,
    });
    return {
      id: converged.id,
      identityHash: converged.identityHash,
      canonicalSpecification: converged.canonicalSpecification,
      type: converged.type,
    };
  }

  const product = await db.connectivityProduct.create({
    data: {
      type: "ESIM",
      name: plan.name,
      description: `${plan.name} — canonical connectivity product`,
      country: plan.country,
      countryCode: plan.countryCode,
      region: plan.region,
      dataAmountMB: plan.dataAmount,
      validityDays: plan.validityDays,
      capabilities: JSON.stringify(["DATA", "ESIM"]),
      sourcePlanId: plan.id,
      canonicalSpecification: identity.canonicalSpecification,
      identityHash: identity.identityHash,
      active: true,
    },
  });

  logger.info("catalog.product.created", {
    productId: product.id,
    sourcePlanId: plan.id,
    identityHash: identity.identityHash,
  });

  return {
    id: product.id,
    identityHash: product.identityHash,
    canonicalSpecification: product.canonicalSpecification,
    type: product.type,
  };
}

/**
 * Resolve the DistributionOffer for (product, tenant).
 * - tenantId null → RoamLink Direct (find or create with retailPrice = planPrice)
 * - tenantId set → must already exist (tenants configure their own pricing)
 *
 * The retail price comes from the DistributionOffer, NEVER from the Plan or
 * ConnectivityOffer.
 */
async function resolveDistributionOffer(input: {
  productId: string;
  tenantId: string | null;
  fallbackRetailPriceMinor: number;
  currency: string;
  distributionOfferId?: string;
}): Promise<{ id: string; retailPrice: number; currency: string }> {
  // Explicit override.
  if (input.distributionOfferId) {
    const offer = await db.distributionOffer.findUnique({
      where: { id: input.distributionOfferId },
    });
    if (!offer) {
      throw new AppError("not_found", "DistributionOffer not found", 404, "This distribution offer is no longer available.");
    }
    // The offer must match the (product, tenant) pair — prevents a tenant
    // from checking out using another tenant's offer.
    if (offer.productId !== input.productId) {
      throw new AppError("conflict", "DistributionOffer does not match product", 409, "This distribution offer is for a different product.");
    }
    if ((offer.tenantId ?? null) !== (input.tenantId ?? null)) {
      throw new AppError("authorization", "DistributionOffer belongs to a different tenant", 403, "You cannot use this distribution offer.");
    }
    if (offer.status !== "active") {
      throw new AppError("conflict", "DistributionOffer inactive", 409, "This distribution offer is no longer active.");
    }
    return { id: offer.id, retailPrice: offer.retailPrice, currency: offer.currency };
  }

  // Look up by (productId, tenantId).
  const offer = await db.distributionOffer.findUnique({
    where: {
      productId_tenantId: {
        productId: input.productId,
        tenantId: input.tenantId ?? "",
      },
    },
  });

  if (offer) {
    if (offer.status !== "active") {
      throw new AppError("conflict", "DistributionOffer inactive", 409, "This distribution offer is no longer active.");
    }
    return { id: offer.id, retailPrice: offer.retailPrice, currency: offer.currency };
  }

  // RoamLink Direct fallback: auto-create a DistributionOffer at the plan's price.
  if (input.tenantId == null) {
    const created = await db.distributionOffer.create({
      data: {
        productId: input.productId,
        tenantId: null,
        retailPrice: input.fallbackRetailPriceMinor,
        currency: input.currency,
        markupPercent: 0,
        status: "active",
        audience: "B2C",
      },
    });
    logger.info("catalog.distribution_offer.auto_created", {
      offerId: created.id,
      productId: input.productId,
      tenantId: null,
      retailPrice: input.fallbackRetailPriceMinor,
    });
    return { id: created.id, retailPrice: created.retailPrice, currency: created.currency };
  }

  // Tenant must configure their own pricing.
  throw new AppError(
    "not_found",
    `No DistributionOffer for product ${input.productId} under tenant ${input.tenantId}`,
    404,
    "This product is not available for your tenant. Please contact your administrator.",
  );
}

// ---------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------

/**
 * Create an order (checkout). Idempotent via client-supplied idempotency key.
 * If the key already exists, the existing order is returned.
 *
 * Phase 2C:
 *   1. Look up the Plan → find the ConnectivityProduct (by sourcePlanId)
 *   2. If no ConnectivityProduct exists, create one (with identityHash)
 *   3. Resolve the DistributionOffer for (product, tenant)
 *   4. Capture immutable snapshot (canonical product identity, distribution offer, retail price)
 *   5. Create the Order with tenantId, amount = DistributionOffer.retailPrice
 */
export async function createOrder(input: {
  userId: string;
  planId: string;
  tenantId?: string | null; // null/undefined = RoamLink Direct
  distributionOfferId?: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<OrderSnapshot> {
  // Idempotency: return existing order for this key.
  const existing = await db.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { plan: true, esim: true },
  });
  if (existing) {
    return toSnapshot(existing as OrderWithIncludes);
  }

  const plan = await getCanonicalPlan(input.planId);
  if (!plan) throw new AppError("not_found", "Plan not found", 404, "This plan is no longer available.");
  if (plan.status !== "active") throw new AppError("conflict", "Plan inactive", 409, "This plan is no longer available.");

  // 1+2. Ensure the canonical ConnectivityProduct exists for this Plan.
  const product = await ensureConnectivityProductForPlan({
    id: plan.id,
    name: plan.name,
    country: plan.country,
    countryCode: plan.countryCode,
    region: plan.region,
    dataAmount: plan.dataAmountMB,
    validityDays: plan.validityDays,
  });

  // 3. Resolve the DistributionOffer (retail price is FROZEN here).
  const distOffer = await resolveDistributionOffer({
    productId: product.id,
    tenantId: input.tenantId ?? null,
    fallbackRetailPriceMinor: plan.priceMinor,
    currency: plan.currency,
    distributionOfferId: input.distributionOfferId,
  });

  // 4. Capture immutable snapshot. The retail price comes from the
  //    DistributionOffer — NOT from the Plan or ConnectivityOffer. The
  //    supplier is intentionally NOT captured here (orchestration happens
  //    at fulfillment time).
  const snapshot = {
    planId: plan.id,
    planName: plan.name,
    country: plan.country,
    countryCode: plan.countryCode,
    dataAmountMB: plan.dataAmountMB,
    validityDays: plan.validityDays,
    currency: plan.currency,
    canonicalProductId: product.id,
    canonicalSpecification: product.canonicalSpecification,
    identityHash: product.identityHash,
    productType: product.type,
    distributionOfferId: distOffer.id,
    retailPriceMinor: distOffer.retailPrice,
    tenantId: input.tenantId ?? null,
  };
  const planSnapshot = JSON.stringify(snapshot);

  // 5. Create the Order.
  const order = await db.order.create({
    data: {
      userId: input.userId,
      planId: input.planId,
      status: "CHECKOUT_CREATED",
      amount: distOffer.retailPrice,
      currency: distOffer.currency,
      paymentStatus: "pending",
      idempotencyKey: input.idempotencyKey,
      planSnapshot,
      tenantId: input.tenantId ?? null,
      fulfillmentStatus: "pending",
      financialStatus: "pending",
    },
    include: { plan: true, esim: true },
  });

  await audit({
    userId: input.userId,
    orderId: order.id,
    action: "order.created",
    entity: "order",
    entityId: order.id,
    ip: input.ip,
    detail: {
      canonicalProductId: product.id,
      distributionOfferId: distOffer.id,
      tenantId: input.tenantId ?? null,
    },
  });
  logger.info("order.created", {
    orderId: order.id,
    userId: input.userId,
    planId: input.planId,
    canonicalProductId: product.id,
    distributionOfferId: distOffer.id,
    tenantId: input.tenantId ?? null,
  });
  return toSnapshot(order as OrderWithIncludes);
}

// ---------------------------------------------------------------------------
// initiatePayment (unchanged from baseline — preserved hardening)
// ---------------------------------------------------------------------------

/**
 * Initiate payment for an order. Creates a payment intent with the provider.
 * Idempotent: re-calling with the same order returns the existing intent.
 */
export async function initiatePayment(input: {
  orderId: string;
  userId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<{
  orderId: string;
  status: OrderStatus;
  paymentReference: string;
  paymentStatus: string;
  clientSecret?: string;
  nextAction?: {
    type: "redirect" | "otp" | "none";
    url?: string;
    instructions?: string;
  };
  providerId: string;
}> {
  const order = await db.order.findUnique({ where: { id: input.orderId }, include: { plan: true } });
  if (!order || order.userId !== input.userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");

  // Already paid? Short-circuit.
  if (order.paymentStatus === "succeeded") {
    return { orderId: order.id, status: order.status as OrderStatus, paymentReference: order.paymentReference ?? "", paymentStatus: "succeeded", providerId: order.paymentProvider ?? "mock" };
  }

  assertTransition(order.status as OrderStatus, "PAYMENT_PENDING");

  const paymentProvider = getPaymentProvider();
  const intent = await paymentProvider.createPaymentIntent({
    amountMinor: order.amount,
    currency: order.currency as Currency,
    description: `eSIM ${order.plan?.name ?? ""}`,
    idempotencyKey: input.idempotencyKey,
    metadata: { orderId: order.id, userId: input.userId },
  });

  // Record the payment row (idempotent on idempotencyKey constraint).
  let payment = await db.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (!payment) {
    payment = await db.payment.create({
      data: {
        userId: input.userId,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        status: "pending",
        provider: paymentProvider.id,
        providerReference: intent.providerReference,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  await db.order.update({
    where: { id: order.id },
    data: {
      status: "PAYMENT_PENDING",
      paymentStatus: "pending",
      paymentProvider: paymentProvider.id,
      paymentReference: intent.providerReference,
    },
  });

  await audit({ userId: input.userId, orderId: order.id, action: "payment.initiated", entity: "payment", entityId: payment.id, ip: input.ip });
  logger.info("payment.initiated", { orderId: order.id, paymentReference: intent.providerReference, provider: paymentProvider.id });
  return {
    orderId: order.id,
    status: "PAYMENT_PENDING",
    paymentReference: intent.providerReference,
    paymentStatus: "pending",
    clientSecret: intent.clientSecret,
    nextAction: intent.nextAction,
    providerId: paymentProvider.id,
  };
}

// ---------------------------------------------------------------------------
// confirmAndProvision + fulfillOrder (Phase 2C)
// ---------------------------------------------------------------------------

/**
 * Confirm payment — SERVER-SIDE verification. This is the single trusted path.
 * After verification, calls fulfillOrder() which runs the orchestration engine,
 * the fulfillment adapter, the persistence handler, and the double-entry ledger.
 */
export async function confirmAndProvision(input: {
  orderId: string;
  userId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<{ status: OrderStatus; paymentStatus: string; esimId: string | null }> {
  const order = await db.order.findUnique({
    where: { id: input.orderId },
    include: { plan: true, esim: true },
  });
  if (!order || order.userId !== input.userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");

  // Already completed? Idempotent return.
  if (order.status === "COMPLETED" && order.esim) {
    return { status: "COMPLETED", paymentStatus: "succeeded", esimId: order.esim.id };
  }

  // Already failed payment? Reject.
  if (order.paymentStatus === "failed") {
    return { status: order.status as OrderStatus, paymentStatus: "failed", esimId: null };
  }

  if (!order.paymentReference) throw new AppError("conflict", "No payment reference", 409, "Payment has not been initiated.");

  // --- SERVER-SIDE payment verification (never trust the client) ---
  const paymentProvider = getPaymentProvider();
  const verification = await paymentProvider.verifyPayment({
    providerReference: order.paymentReference,
    idempotencyKey: input.idempotencyKey,
  });

  if (verification.status === "failed") {
    await db.order.update({
      where: { id: order.id },
      data: { status: "PAYMENT_FAILED", paymentStatus: "failed", failureReason: "Payment verification failed" },
    });
    await db.payment.updateMany({ where: { orderId: order.id, providerReference: order.paymentReference }, data: { status: "failed" } });
    await audit({ userId: input.userId, orderId: order.id, action: "payment.failed", entity: "order", entityId: order.id, ip: input.ip });
    logger.warn("payment.failed", { orderId: order.id });
    return { status: "PAYMENT_FAILED", paymentStatus: "failed", esimId: null };
  }

  if (verification.status === "pending") {
    return { status: "PAYMENT_PENDING", paymentStatus: "pending", esimId: null };
  }

  // verification.status === "succeeded"
  const alreadyPaid =
    order.paymentStatus === "succeeded" &&
    ["PAYMENT_CONFIRMED", "ESIM_PROVISIONING", "ESIM_PROVISIONED", "COMPLETED", "PROVISIONING_FAILED"].includes(order.status);
  if (!alreadyPaid) {
    assertTransition(order.status as OrderStatus, "PAYMENT_CONFIRMED");
    await db.order.update({
      where: { id: order.id },
      data: { status: "PAYMENT_CONFIRMED", paymentStatus: "succeeded" },
    });
    await db.payment.updateMany({ where: { orderId: order.id, providerReference: order.paymentReference }, data: { status: "succeeded" } });
    await audit({ userId: input.userId, orderId: order.id, action: "payment.confirmed", entity: "order", entityId: order.id, ip: input.ip });
    logger.info("payment.confirmed", { orderId: order.id });
  }

  // --- Fulfillment (orchestration + adapter + persistence + ledger) ---
  try {
    const result = await fulfillOrder({
      orderId: order.id,
      userId: input.userId,
      idempotencyKey: `fulfill_${input.idempotencyKey}`,
      ip: input.ip,
    });

    // Complete any pending referral (awards credits to both parties).
    try {
      const { completeReferral } = await import("@/lib/promotions/referral-service");
      await completeReferral({ refereeUserId: input.userId, orderId: order.id });
    } catch (e) {
      logger.warn("referral.completion_failed", { orderId: order.id, error: e instanceof Error ? e.message : String(e) });
    }

    return { status: "COMPLETED", paymentStatus: "succeeded", esimId: result.entityId };
  } catch (err) {
    logger.error("fulfillment.failed", { orderId: order.id, error: err instanceof Error ? err.message : String(err) });
    await db.order.update({
      where: { id: order.id },
      data: { status: "PROVISIONING_FAILED", failureReason: err instanceof Error ? err.message : "Fulfillment failed" },
    });
    await audit({ userId: input.userId, orderId: order.id, action: "fulfillment.failed", entity: "order", entityId: order.id, ip: input.ip });
    throw classifyProviderError("activating your eSIM", err);
  }
}

type OrderSnapshotParsed = {
  canonicalProductId?: string;
  canonicalSpecification?: string | null;
  identityHash?: string | null;
  productType?: string;
  distributionOfferId?: string;
  retailPriceMinor?: number;
  tenantId?: string | null;
};

function parseOrderSnapshot(raw: string | null): OrderSnapshotParsed {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as OrderSnapshotParsed;
  } catch {
    return {};
  }
}

/**
 * Fulfill an order via the orchestration engine + fulfillment adapter +
 * persistence handler + double-entry ledger.
 *
 * This is THE KEY CHANGE in Phase 2C. The supplier is selected HERE, not at
 * checkout time. The retail price was already frozen at checkout (in the
 * DistributionOffer); the wholesale price is read from the SELECTED supplier's
 * ConnectivityOffer and used to finalize the commercial transaction.
 *
 * Idempotent: if the order is already in fulfillmentStatus="success" with a
 * fulfillmentEntityId, returns immediately.
 */
export async function fulfillOrder(input: {
  orderId: string;
  userId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<{ entityId: string; supplierOfferId: string }> {
  const order = await db.order.findUnique({
    where: { id: input.orderId },
    include: { plan: true, esim: true },
  });
  if (!order || order.userId !== input.userId) {
    throw new AppError("not_found", "Order not found", 404, "Order not found.");
  }

  // Idempotent: already fulfilled.
  if (order.fulfillmentStatus === "success" && order.fulfillmentEntityId) {
    logger.info("fulfillment.idempotent_skip", { orderId: order.id, entityId: order.fulfillmentEntityId });
    return { entityId: order.fulfillmentEntityId, supplierOfferId: order.supplierOfferId ?? "" };
  }

  // Payment must be confirmed first (preserved hardening).
  if (order.paymentStatus !== "succeeded") {
    throw new AppError("conflict", "Payment not confirmed", 409, "Payment must be confirmed before fulfillment.");
  }

  // State machine: must be in PAYMENT_CONFIRMED, ESIM_PROVISIONING,
  // PROVISIONING_FAILED, or ESIM_PROVISIONED to fulfill. CHECKOUT_CREATED or
  // PAYMENT_PENDING would skip payment verification.
  const allowedStatuses: OrderStatus[] = ["PAYMENT_CONFIRMED", "ESIM_PROVISIONING", "PROVISIONING_FAILED", "ESIM_PROVISIONED"];
  if (!allowedStatuses.includes(order.status as OrderStatus)) {
    throw new AppError("conflict", `Cannot fulfill from ${order.status}`, 409, "This order is not ready for fulfillment.");
  }

  const snapshot = parseOrderSnapshot(order.planSnapshot);
  if (!snapshot.canonicalProductId) {
    throw new AppError("internal", "Order snapshot missing canonicalProductId", 500, "Order is missing canonical product identity.");
  }

  // Transition order status: PAYMENT_CONFIRMED -> ESIM_PROVISIONING (preserved hardening).
  if (order.status === "PAYMENT_CONFIRMED" || order.status === "PROVISIONING_FAILED") {
    assertTransition(order.status as OrderStatus, "ESIM_PROVISIONING");
    await db.order.update({ where: { id: order.id }, data: { status: "ESIM_PROVISIONING" } });
  }

  // 1. Fulfillment state machine: pending|failed -> provisioning.
  const currentFs = order.fulfillmentStatus as FulfillmentStatus;
  if (canTransitionFulfillment(currentFs, "provisioning")) {
    await transitionFulfillment(order.id, currentFs, "provisioning");
  }

  // 2. Orchestrate: select the best supplier offer for the canonical product.
  const selected = await selectSupplierForProduct(snapshot.canonicalProductId);

  // 3. Reserve provider credit (atomic conditional update, idempotent).
  const reservationId = `res_${order.id}_${selected.offerId}`;
  const providerKey = selected.providerKey ?? (await resolveProviderKey(selected.supplierId));
  await ensureProviderAccount(providerKey);
  await reserveProviderCommitment({
    reservationId,
    provider: providerKey,
    amountMinor: selected.wholesalePrice,
    orderId: order.id,
  });

  // 4. Record the selected supplier offer on the order (so subsequent
  //    fulfillments of the same order use the same supplier).
  await db.order.update({
    where: { id: order.id },
    data: { supplierOfferId: selected.offerId },
  });

  // 5. Resolve the fulfillment adapter (from supplier.providerKey).
  const adapter = getAdapter(providerKey);

  // 6. Resolve the persistence handler (from snapshot.productType).
  const productType = (snapshot.productType ?? "ESIM").toUpperCase();
  const persistence = getPersistenceHandler(productType);

  // 7. Build the fulfillment context.
  const ctx: FulfillmentContext = {
    orderId: order.id,
    userId: order.userId,
    productId: snapshot.canonicalProductId,
    productType,
    sourcePlanId: order.planId,
    canonicalSpecification: snapshot.canonicalSpecification ?? null,
    supplierOfferId: selected.offerId,
    supplierId: selected.supplierId,
    idempotencyKey: input.idempotencyKey,
  };

  try {
    // 8. Create provider order + provision.
    const plan = order.plan;
    if (!plan) {
      throw new AppError("internal", "Order has no Plan", 500, "Order is missing the source plan.");
    }
    const { providerOrderId } = await adapter.createProviderOrder({
      context: ctx,
      providerPlanId: plan.providerPlanId,
    });

    const result = await adapter.provision({ context: ctx, providerOrderId });

    // 9. Persist the fulfillment entity (Esim, VirtualNumber, ...).
    const persisted = await persistence.persist({
      context: ctx,
      result,
      providerOrderId,
    });

    // 10. Transition fulfillment: provisioning -> success.
    await transitionFulfillment(order.id, "provisioning", "success", {
      fulfillmentExternalReference: result.externalReference,
      fulfillmentEntityId: persisted.entityId,
    });

    // 11. Transition order status: ESIM_PROVISIONING -> ESIM_PROVISIONED -> COMPLETED.
    assertTransition("ESIM_PROVISIONING", "ESIM_PROVISIONED");
    await db.order.update({
      where: { id: order.id },
      data: { status: "ESIM_PROVISIONED" },
    });
    assertTransition("ESIM_PROVISIONED", "COMPLETED");
    await db.order.update({
      where: { id: order.id },
      data: { status: "COMPLETED" },
    });

    // 12. Settle the credit reservation.
    await settleReservation(reservationId);

    // 13. Finalize the commercial transaction in the double-entry ledger.
    //     Uses the customer price (frozen at checkout) and the wholesale price
    //     from the SELECTED supplier offer.
    const customerPrice = order.amount; // frozen from DistributionOffer
    const paymentFee = Math.round(customerPrice * 0.029 + 30); // ~2.9% + $0.30
    await finalizeCommercialTransaction({
      orderId: order.id,
      userId: order.userId,
      customerPriceMinor: customerPrice,
      wholesalePriceMinor: selected.wholesalePrice,
      paymentFeeMinor: paymentFee,
      currency: order.currency,
      provider: providerKey,
      providerTxnId: providerOrderId,
      idempotencyKey: `fin_${order.id}`,
    });

    // Record provider reliability (legacy hardening).
    recordProviderResult(providerKey, true, 0);

    await audit({
      userId: input.userId,
      orderId: order.id,
      action: "fulfillment.succeeded",
      entity: "order",
      entityId: order.id,
      ip: input.ip,
      detail: {
        supplierOfferId: selected.offerId,
        supplierId: selected.supplierId,
        providerKey,
        entityId: persisted.entityId,
        wholesalePrice: selected.wholesalePrice,
      },
    });

    logger.info("fulfillment.succeeded", {
      orderId: order.id,
      supplierOfferId: selected.offerId,
      supplierId: selected.supplierId,
      entityId: persisted.entityId,
    });

    return { entityId: persisted.entityId, supplierOfferId: selected.offerId };
  } catch (err) {
    logger.error("fulfillment.error", {
      orderId: order.id,
      supplierOfferId: selected.offerId,
      error: err instanceof Error ? err.message : String(err),
    });

    // Definitive failure: release the credit reservation and mark failed.
    await releaseReservation(reservationId);
    await transitionFulfillment(order.id, "provisioning", "failed", {
      failureReason: err instanceof Error ? err.message : "Fulfillment failed",
    });

    // Record provider failure (legacy hardening).
    recordProviderResult(providerKey, false, 0);

    await db.order.update({
      where: { id: order.id },
      data: {
        status: "PROVISIONING_FAILED",
        failureReason: err instanceof Error ? err.message : "Fulfillment failed",
      },
    });

    throw err;
  }
  // NOTE: If the adapter returns status="unknown" (e.g. timeout), we do NOT
  // release the reservation here. The caller can re-run fulfillOrder, which
  // will detect the existing supplierOfferId and retry the same supplier.
  // A reconciliation job (not implemented here) would handle truly stuck
  // orders by transitioning them to "reconciliation_required".
}

/**
 * Backward-compatible alias for fulfillOrder. Existing callers (tests, retry
 * paths) can continue to call provisionOrderESIM; it now routes through the
 * new orchestration-driven fulfillment path.
 */
export async function provisionOrderESIM(input: {
  orderId: string;
  userId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<string> {
  const order = await db.order.findUnique({ where: { id: input.orderId } });
  if (!order || order.userId !== input.userId) {
    throw new AppError("not_found", "Order not found", 404, "Order not found.");
  }

  // Already provisioned? Idempotent return.
  if (order.fulfillmentStatus === "success" && order.fulfillmentEntityId) {
    return order.fulfillmentEntityId;
  }

  // Payment must be confirmed first.
  if (order.paymentStatus !== "succeeded") {
    throw new AppError("conflict", "Payment not confirmed", 409, "Payment must be confirmed before provisioning.");
  }

  const result = await fulfillOrder(input);
  return result.entityId;
}

/** Get an order snapshot. */
export async function getOrder(orderId: string, userId: string): Promise<OrderSnapshot> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { plan: true, esim: true } });
  if (!order || order.userId !== userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");
  return toSnapshot(order as OrderWithIncludes);
}

/** List a user's orders. */
export async function listUserOrders(userId: string): Promise<OrderSnapshot[]> {
  const orders = await db.order.findMany({ where: { userId }, include: { plan: true, esim: true }, orderBy: { createdAt: "desc" } });
  return orders.map((o) => toSnapshot(o as OrderWithIncludes));
}

/** Retry provisioning for a PROVISIONING_FAILED order. */
export async function retryProvisioning(orderId: string, userId: string, ip?: string): Promise<{ status: OrderStatus; esimId: string | null }> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { esim: true } });
  if (!order || order.userId !== userId) throw new AppError("not_found", "Order not found", 404, "Order not found.");
  if (order.fulfillmentStatus === "success" && order.fulfillmentEntityId) {
    return { status: "COMPLETED", esimId: order.fulfillmentEntityId };
  }
  if (order.paymentStatus !== "succeeded") throw new AppError("conflict", "Payment not confirmed", 409, "Payment must be confirmed before retrying.");
  const result = await fulfillOrder({
    orderId,
    userId,
    idempotencyKey: `prov_retry_${order.id}_${Date.now()}`,
    ip,
  });
  return { status: "COMPLETED", esimId: result.entityId };
}

// Re-export for tests / admin.
export { getFulfillmentStatus };
