/**
 * Phase 7.6 — Offer Rating API
 * POST /api/commerce/orders/[orderId]/rate
 *
 * Customer rates an order (1-5 stars). Creates an OfferRating linked to
 * the offer that was purchased, for trust signals.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { orderId } = await params;
  const body = await req.json();
  const { rating, review } = body;

  if (!rating || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "Rating must be 1-5" }, { status: 400 });
  }

  // Verify the order belongs to this tenant + is fulfilled
  const order = await db.customerOrder.findFirst({
    where: { id: orderId, tenantId: ctx.tenantId, status: "fulfilled" },
  });

  if (!order) {
    return NextResponse.json({ error: "Order not found or not fulfilled" }, { status: 404 });
  }

  // Find the offer linked to this order (via the product)
  const product = await db.resellerProduct.findUnique({
    where: { id: order.productId },
    select: { id: true },
  });

  // Find any ConnectivityOffer2 linked to this product
  const offer = await db.connectivityOffer2.findFirst({
    where: { resellerProductId: order.productId },
    select: { id: true },
  });

  // Create the rating (idempotent — one per order)
  const ratingRecord = await db.offerRating.upsert({
    where: { orderId },
    create: {
      offerId: offer?.id ?? "unknown",
      tenantId: ctx.tenantId,
      customerId: order.customerId,
      orderId,
      rating,
      review: review ?? null,
    },
    update: {
      rating,
      review: review ?? null,
    },
  });

  return NextResponse.json({ rating: ratingRecord });
}
