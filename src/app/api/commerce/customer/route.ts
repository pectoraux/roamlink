/**
 * Phase 5.1C — Customer find-or-create API (SECURITY FIXED)
 * POST /api/commerce/customer
 *
 * SECURITY FIX (Phase 5.1C):
 * The previous version of this route had NO authentication and trusted the
 * `tenantId` from the request body — allowing anyone to create users in
 * any tenant. This was a P1 security vulnerability.
 *
 * The fix: the `tenantId` is NO LONGER trusted from the request body. It's
 * derived from the `productId` — the customer is created in the tenant that
 * owns the product. This means a customer can only be created in a tenant
 * that has a product they're trying to buy.
 *
 * Additionally, the route verifies the product is active before creating
 * the customer, preventing creation against archived/inactive products.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/security";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { email, name, productId } = body;

  if (!email || !productId) {
    return NextResponse.json(
      { error: "Missing required fields: email, productId" },
      { status: 400 },
    );
  }

  // SECURITY: derive tenantId from the product, NOT from the request body.
  // This prevents an attacker from creating users in arbitrary tenants.
  const product = await db.resellerProduct.findFirst({
    where: { id: productId, status: "active" },
    select: { tenantId: true },
  });

  if (!product) {
    return NextResponse.json({ error: "Product not found or inactive" }, { status: 404 });
  }

  const tenantId = product.tenantId;

  // Find or create the user
  let user = await db.user.findUnique({
    where: { email },
  });

  if (!user) {
    // Create a new customer user with a random password (they'll reset it later)
    const randomPassword = Math.random().toString(36).slice(2) + Date.now().toString(36);
    user = await db.user.create({
      data: {
        email,
        name: name ?? null,
        passwordHash: await hashPassword(randomPassword),
        role: "customer",
      },
    });
  }

  // Link the user to the tenant (if not already linked)
  const existingMembership = await db.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId, userId: user.id } },
  });

  if (!existingMembership) {
    await db.tenantUser.create({
      data: {
        tenantId,
        userId: user.id,
        role: "viewer", // customers have viewer role in the tenant context
      },
    });
  }

  logger.info("commerce.customer_created", {
    userId: user.id,
    tenantId,
    productId,
  });

  return NextResponse.json({ customer: { id: user.id, email: user.email, name: user.name } });
}
