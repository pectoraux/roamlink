/**
 * Tenant Orders API.
 *   GET  /api/tenant/orders       — list tenant orders
 *   POST /api/tenant/orders       — create order for a tenant customer
 *   GET  /api/tenant/orders/:id   — get order detail
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_WRITE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { getTenantOrders, getTenantOrder } from "@/lib/tenant/service";
import { getTenantCustomer } from "@/lib/tenant/customers";
import { getDistributionOfferForTenant } from "@/lib/tenant/service";
import { assertCanCreateOrder } from "@/lib/tenant/entitlements";
import { createOrder, confirmAndProvision } from "@/lib/orders/service";
import { generateIdempotencyKey } from "@/lib/orders/idempotency";
import { json, errorResponse } from "@/lib/api";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

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

    // Entitlement check
    await assertCanCreateOrder(ctx.tenantId);

    // Verify the customer belongs to this tenant
    const customer = await getTenantCustomer(ctx.tenantId, tenantCustomerId);

    // Verify the distribution offer belongs to this tenant + get the product
    const distOffer = await getDistributionOfferForTenant(distributionOfferId, ctx.tenantId);

    // Get the canonical plan from the product (for the order service)
    const plan = await db.plan.findFirst({
      where: {
        country: distOffer.product.country,
        dataAmount: distOffer.product.dataAmount,
        validityDays: distOffer.product.validityDays,
        status: "active",
      },
    });
    if (!plan) {
      throw new AppError("not_found", "No matching plan for this product", 404, "The underlying plan is not available.");
    }

    // Create the order with tenant context
    const idempotencyKey = `tenant_order_${ctx.tenantId}_${tenantCustomerId}_${distributionOfferId}_${Date.now()}`;
    const order = await createOrder({
      userId: user.id,
      planId: plan.id,
      tenantId: ctx.tenantId,
      distributionOfferId,
      tenantCustomerId,
      idempotencyKey,
      ip: undefined,
    });

    // Auto-confirm with mock payment (reseller orders are invoiced, not card-paid)
    // In production, this would go through a reseller-billing path.
    const result = await confirmAndProvision({
      orderId: order.id,
      paymentProvider: "mock",
      paymentReference: `tenant_pay_${order.id}`,
      paymentFee: 0,
      idempotencyKey: `confirm_${idempotencyKey}`,
      ip: undefined,
    });

    return json({ order, result }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
