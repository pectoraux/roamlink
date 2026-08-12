/**
 * Tenant Orders API.
 *   GET  /api/tenant/orders       — list tenant orders
 *   POST /api/tenant/orders       — create order for a tenant customer
 *   GET  /api/tenant/orders/:id   — get order detail
 *
 * Phase 2B.1:
 *   - Canonical product resolution: DistributionOffer → ConnectivityProduct → sourcePlanId → Plan
 *     (NOT fuzzy attribute lookup by country/dataAmount/validityDays)
 *   - Real idempotency: client-supplied Idempotency-Key header (NOT Date.now())
 *   - Reseller balance: debits from TenantBalance (NOT mock B2C payment)
 *   - Platform fee: calculated and posted to a separate ledger revenue account
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_WRITE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { getTenantOrders, getTenantOrder, getDistributionOfferForTenant } from "@/lib/tenant/service";
import { getTenantCustomer } from "@/lib/tenant/customers";
import { assertCanCreateOrder, calculatePlatformFee } from "@/lib/tenant/entitlements";
import { debitResellerBalance, getTenantBalanceMinor } from "@/lib/tenant/balance";
import { createOrder, confirmAndProvision } from "@/lib/orders/service";
import { json, errorResponse } from "@/lib/api";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const orders = await getTenantOrders(ctx.tenantId);
    return json({ orders }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_WRITE_ROLES);

    const body = await req.json();
    const { tenantCustomerId, distributionOfferId } = body;

    if (!tenantCustomerId || !distributionOfferId) {
      return json({ error: "tenantCustomerId and distributionOfferId are required" }, 400);
    }

    // Phase 2B.1 §4: Real idempotency — client MUST supply a stable key.
    // Repeated requests with the same key return the same order.
    const idempotencyKey = req.headers.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.length < 8) {
      return json({ error: "Idempotency-Key header is required (min 8 characters)" }, 400);
    }

    // Entitlement check
    await assertCanCreateOrder(ctx.tenantId);

    // Verify the customer belongs to this tenant
    const customer = await getTenantCustomer(ctx.tenantId, tenantCustomerId);

    // Verify the distribution offer belongs to this tenant + get the product
    const distOffer = await getDistributionOfferForTenant(distributionOfferId, ctx.tenantId);

    // Phase 2B.1 §2: Canonical product resolution.
    // DistributionOffer → ConnectivityProduct → sourcePlanId → Plan
    // (NOT fuzzy attribute lookup by country/dataAmount/validityDays)
    const product = await db.connectivityProduct.findUnique({
      where: { id: distOffer.productId },
    });
    if (!product) {
      throw new AppError("not_found", "Connectivity product not found", 404, "The underlying product is not available.");
    }
    if (!product.sourcePlanId) {
      throw new AppError("not_found", "Product has no source plan", 404, "This product is not linked to a plan.");
    }
    const plan = await db.plan.findUnique({
      where: { id: product.sourcePlanId },
    });
    if (!plan || plan.status !== "active") {
      throw new AppError("not_found", "Source plan not available", 404, "The underlying plan is not available.");
    }

    // Phase 2B.1 P0: Check reseller balance BEFORE creating the order.
    const retailPrice = distOffer.retailPrice;
    const balance = await getTenantBalanceMinor(ctx.tenantId);
    if (balance < retailPrice) {
      throw new AppError(
        "validation",
        `Insufficient balance: ${balance} < ${retailPrice}`,
        402,
        `Insufficient reseller balance. Current: $${(balance / 100).toFixed(2)}, required: $${(retailPrice / 100).toFixed(2)}. Please deposit more funds.`,
      );
    }

    // Create the order with tenant context (idempotent via the client key)
    const order = await createOrder({
      userId: user.id,
      planId: plan.id,
      tenantId: ctx.tenantId,
      distributionOfferId,
      tenantCustomerId,
      idempotencyKey,
      ip: undefined,
    });

    // Phase 2B.1 P0: Debit the reseller balance (NOT mock B2C payment).
    // This is a real financial transaction:
    //   - Dr Reseller Funds Liability (reduces what RoamLink owes the reseller)
    //   - Cr Sales Revenue (connectivity revenue)
    //   - Cr Platform Fee Revenue (RoamLink's platform fee, separated)
    const platformFee = await calculatePlatformFee(ctx.tenantId, retailPrice);
    const debit = await debitResellerBalance({
      tenantId: ctx.tenantId,
      userId: user.id,
      orderId: order.id,
      amountMinor: retailPrice,
      platformFeeMinor: platformFee.totalFeeMinor,
      idempotencyKey: `reseller_purchase_${order.id}`,
      description: `Connectivity purchase: ${plan.name} for ${customer.name}`,
    });

    // Confirm the order payment (paymentProvider = "reseller_balance" — NOT "mock")
    // and provision through the existing orchestration engine.
    const result = await confirmAndProvision({
      orderId: order.id,
      paymentProvider: "reseller_balance",
      paymentReference: debit.transactionId,
      paymentFee: 0,
      idempotencyKey: `confirm_${idempotencyKey}`,
      ip: undefined,
    });

    logger.info("reseller.order_completed", {
      tenantId: ctx.tenantId,
      orderId: order.id,
      customerId: tenantCustomerId,
      retailPrice,
      platformFee: platformFee.totalFeeMinor,
      balanceAfter: debit.balanceMinor,
    });

    return json({ order, result, balanceAfter: debit.balanceMinor }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
