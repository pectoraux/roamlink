/**
 * Phase 3 — Product Detail API
 * GET    /api/commerce/products/[productId] — get a product
 * PATCH  /api/commerce/products/[productId] — update a product
 * DELETE /api/commerce/products/[productId] — archive a product
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { productId } = await params;
  const product = await db.resellerProduct.findFirst({
    where: { id: productId, tenantId: ctx.tenantId },
  });

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  return NextResponse.json({ product });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { productId } = await params;
  const body = await req.json();

  const product = await db.resellerProduct.updateMany({
    where: { id: productId, tenantId: ctx.tenantId },
    data: {
      ...(body.name && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.priceMinor !== undefined && { priceMinor: body.priceMinor }),
      ...(body.currency && { currency: body.currency }),
      ...(body.status && { status: body.status }),
      ...(body.capabilitySet && {
        capabilitySet: typeof body.capabilitySet === "string" ? body.capabilitySet : JSON.stringify(body.capabilitySet),
      }),
    },
  });

  if (product.count === 0) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { productId } = await params;
  const product = await db.resellerProduct.updateMany({
    where: { id: productId, tenantId: ctx.tenantId },
    data: { status: "archived" },
  });

  if (product.count === 0) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
