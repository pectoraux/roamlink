/**
 * Phase 5.1 — Payment Intent API
 * POST /api/commerce/orders/[orderId]/payment-intent
 *
 * Creates a real payment intent via the configured payment provider
 * (Paystack/Stripe/Mock). Returns the provider reference + redirect URL
 * for the customer to complete payment.
 *
 * This replaces the simulated payment flow. The customer is redirected to
 * the provider's hosted payment page. After payment, the provider sends a
 * webhook to /api/webhooks/commerce/[provider], which marks the order paid
 * and calls fulfillOrder().
 *
 * The payment provider is selected from the tenant's subscription
 * (paymentProvider field) or defaults to the platform's PAYMENT_PROVIDER
 * env var.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { getPaymentProvider, getPaymentProviderByKey } from "@/lib/payments";
import { logger } from "@/lib/logger";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { orderId } = await params;

  const order = await db.customerOrder.findFirst({
    where: { id: orderId, tenantId: ctx.tenantId },
    include: { product: true },
  });

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  if (order.status !== "pending") {
    return NextResponse.json(
      { error: `Order status is "${order.status}", expected "pending"` },
      { status: 400 },
    );
  }

  // Determine the payment provider: tenant's subscription provider, or platform default
  const subscription = await db.tenantSubscription.findFirst({
    where: { tenantId: ctx.tenantId, status: "active" },
    select: { paymentProvider: true },
  });

  const providerKey = subscription?.paymentProvider || process.env.PAYMENT_PROVIDER || "mock";
  const provider = providerKey === (process.env.PAYMENT_PROVIDER || "mock")
    ? getPaymentProvider()
    : getPaymentProviderByKey(providerKey);

  // Create a payment intent (idempotent via orderId)
  const idempotencyKey = `commerce-order-${order.id}`;

  try {
    const intent = await provider.createPaymentIntent({
      amountMinor: order.paidAmountMinor,
      currency: order.currency as "USD" | "GHS" | "NGN",
      description: `${order.product.name} — ${ctx.tenant.name}`,
      idempotencyKey,
      metadata: {
        orderId: order.id,
        tenantId: ctx.tenantId,
        customerId: order.customerId,
        productId: order.productId,
      },
    });

    // Store the payment reference on the order
    await db.customerOrder.update({
      where: { id: orderId },
      data: {
        paymentRef: intent.providerReference,
      },
    });

    // Also create a Payment record for audit trail
    await db.payment.upsert({
      where: { idempotencyKey },
      create: {
        userId: order.customerId,
        orderId: order.id,
        amount: order.paidAmountMinor,
        currency: order.currency,
        status: "pending",
        provider: provider.id,
        providerReference: intent.providerReference,
        idempotencyKey,
      },
      update: {
        providerReference: intent.providerReference,
      },
    });

    logger.info("commerce.payment_intent_created", {
      orderId: order.id,
      provider: provider.id,
      providerReference: intent.providerReference,
    });

    return NextResponse.json({
      provider: provider.id,
      providerReference: intent.providerReference,
      status: intent.status,
      nextAction: intent.nextAction,
    });
  } catch (err) {
    logger.error("commerce.payment_intent_failed", {
      orderId: order.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to create payment intent" },
      { status: 500 },
    );
  }
}
