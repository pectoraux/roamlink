/**
 * Phase 3 — Customer Order API
 * POST /api/commerce/orders — create an order (status: pending)
 * GET  /api/commerce/orders — list orders for the tenant
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const orders = await db.customerOrder.findMany({
    where: { tenantId: ctx.tenantId },
    include: {
      product: true,
      customer: { select: { id: true, email: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ orders });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { productId, customerId } = body;

  if (!productId || !customerId) {
    return NextResponse.json(
      { error: "Missing required fields: productId, customerId" },
      { status: 400 },
    );
  }

  const product = await db.resellerProduct.findFirst({
    where: { id: productId, tenantId: ctx.tenantId, status: "active" },
  });

  if (!product) {
    return NextResponse.json({ error: "Product not found or inactive" }, { status: 404 });
  }

  // Phase 12.2 P1-1: Fixed — was using db.tenantUser (staff) instead of
  // db.tenantCustomer (actual customers). This bug meant only staff members
  // could be the customerId of a commerce order.
  const customer = await db.tenantCustomer.findFirst({
    where: { id: customerId, tenantId: ctx.tenantId, status: "active" },
  });

  if (!customer) {
    return NextResponse.json({ error: "Customer not found in this tenant" }, { status: 404 });
  }

  const order = await db.customerOrder.create({
    data: {
      tenantId: ctx.tenantId,
      customerId,
      productId,
      status: "pending",
      paidAmountMinor: product.priceMinor,
      currency: product.currency,
    },
  });

  return NextResponse.json({ order }, { status: 201 });
}
