/**
 * Phase 6.2 — Intent Purchase API
 * POST /api/commerce/intent/[intentId]/purchase
 *
 * Purchases a specific offer from a ranked intent. This completes the
 * marketplace flow:
 *   intent → ranked offers → select offer → create order → payment → fulfillment
 *
 * The selected offer is linked to a ResellerProduct (or a product is created
 * on the fly from the offer), then the standard checkout flow runs:
 *   1. Create a CustomerOrder (status: pending)
 *   2. Create a payment intent (via the payment provider)
 *   3. Return the payment redirect URL
 *   4. After payment, the webhook calls fulfillOrder() → entitlement + provisioning + ledger + earnings
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { getPaymentProvider } from "@/lib/payments";
import { logger } from "@/lib/logger";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { intentId } = await params;
  const body = await req.json();
  const { offerId } = body;

  if (!offerId) {
    return NextResponse.json({ error: "offerId is required" }, { status: 400 });
  }

  // Step 1: Load the intent request
  const intentRequest = await db.intentRequest.findFirst({
    where: { id: intentId, tenantId: ctx.tenantId },
  });

  if (!intentRequest) {
    return NextResponse.json({ error: "Intent not found" }, { status: 404 });
  }

  // Step 2: Load the selected offer
  const offer = await db.connectivityOffer2.findFirst({
    where: { id: offerId, tenantId: ctx.tenantId, status: "active" },
  });

  if (!offer) {
    return NextResponse.json({ error: "Offer not found or inactive" }, { status: 404 });
  }

  // Step 3: Find or create a ResellerProduct from the offer
  let product = offer.resellerProductId
    ? await db.resellerProduct.findUnique({ where: { id: offer.resellerProductId } })
    : null;

  if (!product) {
    product = await db.resellerProduct.create({
      data: {
        tenantId: ctx.tenantId,
        name: `${offer.capabilityType} — ${offer.providerType}`,
        capabilityType: offer.capabilityType,
        providerType: offer.providerType,
        pricingModel: "FLAT",
        priceMinor: offer.customerPriceMinor,
        currency: offer.currency,
        billingCycle: "one_time",
        capabilitySet: offer.spec,
        status: "active",
      },
    });

    // Link the offer to the product
    await db.connectivityOffer2.update({
      where: { id: offer.id },
      data: { resellerProductId: product.id },
    });
  }

  // Step 4: Create a CustomerOrder (status: pending)
  const order = await db.customerOrder.create({
    data: {
      tenantId: ctx.tenantId,
      customerId: user.id,
      productId: product.id,
      status: "pending",
      paidAmountMinor: offer.customerPriceMinor,
      currency: offer.currency,
    },
  });

  // Step 5: Update the intent request
  await db.intentRequest.update({
    where: { id: intentId },
    data: {
      selectedOfferId: offerId,
      status: "purchased",
    },
  });

  // Step 6: Create a payment intent
  const provider = getPaymentProvider();
  const idempotencyKey = `commerce-intent-${intentId}-${offerId}`;

  try {
    const intent = await provider.createPaymentIntent({
      amountMinor: offer.customerPriceMinor,
      currency: offer.currency as "USD" | "GHS" | "NGN",
      description: `${product.name} — ${ctx.tenant.name}`,
      idempotencyKey,
      metadata: {
        orderId: order.id,
        tenantId: ctx.tenantId,
        customerId: user.id,
        productId: product.id,
        intentId,
        offerId,
      },
    });

    await db.customerOrder.update({
      where: { id: order.id },
      data: { paymentRef: intent.providerReference },
    });

    await db.payment.upsert({
      where: { idempotencyKey },
      create: {
        userId: user.id,
        orderId: order.id,
        amount: offer.customerPriceMinor,
        currency: offer.currency,
        status: "pending",
        provider: provider.id,
        providerReference: intent.providerReference,
        idempotencyKey,
      },
      update: {},
    });

    logger.info("intent.purchased", {
      intentId,
      offerId,
      orderId: order.id,
      providerReference: intent.providerReference,
    });

    return NextResponse.json({
      orderId: order.id,
      provider: provider.id,
      providerReference: intent.providerReference,
      nextAction: intent.nextAction,
    });
  } catch (err) {
    logger.error("intent.purchase_failed", {
      intentId,
      offerId,
      orderId: order.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to create payment" }, { status: 500 });
  }
}
