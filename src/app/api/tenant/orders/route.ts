/**
 * Tenant Orders API.
 *   GET  /api/tenant/orders       — list tenant orders
 *   POST /api/tenant/orders       — create order for a tenant customer
 *   GET  /api/tenant/orders/:id   — get order detail
 *
 * Phase 2B.2:
 *   - Reservation lifecycle: reserve → fulfill → settle/release
 *   - On successful fulfillment: settleResellerReservation (recognizes revenue)
 *   - On failed fulfillment: releaseResellerReservation (returns funds)
 *   - Balance is reserved BEFORE fulfillment, not consumed immediately
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_WRITE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { getTenantOrders, getTenantOrder, getDistributionOfferForTenant } from "@/lib/tenant/service";
import { getTenantCustomer } from "@/lib/tenant/customers";
import { assertCanCreateOrder, calculatePlatformFee } from "@/lib/tenant/entitlements";
import { reserveResellerBalance, settleResellerReservation, releaseResellerReservation, getTenantBalanceMinor } from "@/lib/tenant/balance";
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

    // Phase 2B.2: Check available balance BEFORE creating the order.
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

    // Phase 2B.2 P0-1: RESERVE the balance (NOT immediately consume).
    // Funds move from available to reserved. No revenue recognized yet.
    const platformFee = await calculatePlatformFee(ctx.tenantId, retailPrice);
    const reservation = await reserveResellerBalance({
      tenantId: ctx.tenantId,
      userId: user.id,
      orderId: order.id,
      amountMinor: retailPrice,
      platformFeeMinor: platformFee.totalFeeMinor,
      idempotencyKey: `reserve_${order.id}`,
      description: `Reservation for: ${plan.name} for ${customer.name}`,
    });

    // Confirm the order payment + provision through the orchestration engine.
    // paymentProvider = "reseller_balance" — the reservation is the payment proof.
    let result;
    try {
      result = await confirmAndProvision({
        orderId: order.id,
        userId: user.id,
        idempotencyKey: `confirm_${idempotencyKey}`,
        ip: undefined,
      });

      // Phase 2B.2: If fulfillment failed, RELEASE the reservation (return funds)
      if (result.status === "PROVISIONING_FAILED" || result.status === "PAYMENT_FAILED") {
        await releaseResellerReservation({
          tenantId: ctx.tenantId,
          userId: user.id,
          orderId: order.id,
          reason: `Fulfillment failed: ${result.status}`,
        });
        logger.warn("reseller.order_failed_released", {
          tenantId: ctx.tenantId,
          orderId: order.id,
          status: result.status,
        });
        return json({ order, result, reservation: { state: "RELEASED" } }, 201);
      }

      // Phase 2B.2: Fulfillment succeeded — SETTLE the reservation (recognize revenue)
      const settlement = await settleResellerReservation({
        tenantId: ctx.tenantId,
        userId: user.id,
        orderId: order.id,
      });

      logger.info("reseller.order_completed_settled", {
        tenantId: ctx.tenantId,
        orderId: order.id,
        customerId: tenantCustomerId,
        retailPrice,
        platformFee: platformFee.totalFeeMinor,
        balanceAfter: reservation.balanceMinor,
        ledgerTxnId: settlement.ledgerTransactionId,
      });

      return json({
        order,
        result,
        reservation: { id: settlement.reservationId, state: settlement.state, ledgerTransactionId: settlement.ledgerTransactionId },
        balanceAfter: reservation.balanceMinor,
      }, 201);
    } catch (fulfillErr) {
      // Fulfillment threw an error — RELEASE the reservation
      const errMsg = fulfillErr instanceof Error ? fulfillErr.message : String(fulfillErr);
      await releaseResellerReservation({
        tenantId: ctx.tenantId,
        userId: user.id,
        orderId: order.id,
        reason: `Fulfillment error: ${errMsg}`,
      }).catch((releaseErr) => {
        logger.error("reseller.release_failed_after_fulfillment_error", {
          orderId: order.id,
          fulfillmentError: errMsg,
          releaseError: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      });
      throw fulfillErr;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
