/**
 * Phase 3 — Order Fulfillment API
 * POST /api/commerce/orders/[orderId]/fulfill
 *
 * Marks the order as "paid" and calls fulfillOrder() to create the
 * entitlement and provision the resource via the frozen kernel.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { fulfillOrder } from "@/lib/commerce/fulfillment";

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

  await db.customerOrder.update({
    where: { id: orderId },
    data: { status: "paid", paymentRef: `sim-${Date.now()}` },
  });

  const result = await fulfillOrder(orderId);

  return NextResponse.json({ result });
}
