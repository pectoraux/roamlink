/**
 * Phase 5.1C — Customer find-or-create API (SECURITY FIXED)
 * POST /api/commerce/customer
 *
 * Phase 12.2 P1-2: Added authentication requirement. Previously unauthenticated —
 * anyone could create User + TenantUser rows. Now requires a logged-in user.
 *
 * The tenantId is derived from the productId (NOT from the request body).
 * The product must be active. The user must be authenticated.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/security";
import { logger } from "@/lib/logger";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";

export async function POST(req: NextRequest) {
  // Phase 12.2 P1-2: Require authentication.
  const authUser = await getCurrentUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Phase 12.2 P0-7: Require tenant context — the caller must have an active
  // tenant, and that tenant must match the product's tenant.
  const ctx = await requireTenantContext(authUser);

  const body = await req.json();
  const { email, name, productId } = body;

  if (!email || !productId) {
    return NextResponse.json(
      { error: "Missing required fields: email, productId" },
      { status: 400 },
    );
  }

  // SECURITY: derive tenantId from the product, NOT from the request body.
  const product = await db.resellerProduct.findFirst({
    where: { id: productId, status: "active" },
    select: { tenantId: true },
  });

  if (!product) {
    return NextResponse.json({ error: "Product not found or inactive" }, { status: 404 });
  }

  // Phase 12.2 P0-7: Verify the product's tenant matches the caller's active tenant.
  if (product.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: "Product does not belong to your active tenant" }, { status: 403 });
  }

  const tenantId = ctx.tenantId;

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
    createdBy: authUser.id,
  });

  return NextResponse.json({ customer: { id: user.id, email: user.email, name: user.name } });
}
