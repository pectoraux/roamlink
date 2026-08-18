/**
 * Phase 5.1C — Customer find-or-create API (SECURITY FIXED)
 * POST /api/commerce/customer
 *
 * Phase 12.3.3: Canonical error envelope.
 * Phase 12.2 P1-2: Requires authentication.
 * Phase 12.2 P0-7: Product's tenant must match caller's active tenant.
 *
 * The tenantId is derived from the productId (NOT from the request body).
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/security";
import { logger } from "@/lib/logger";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { getRequestId, apiErrorResponse, apiSuccessResponse } from "@/lib/api/protocol";
import { AppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    // Phase 12.2 P1-2: Require authentication.
    const authUser = await getCurrentUser();
    if (!authUser) {
      throw new AppError("auth", "No API key or session provided", 401, "Authentication is required.");
    }

    // Phase 12.2 P0-7: Require tenant context.
    const ctx = await requireTenantContext(authUser);

    const body = await req.json();
    const { email, name, productId } = body;

    if (!email || !productId) {
      throw new AppError("validation", "Missing required fields: email, productId", 400, "Missing required fields: email, productId.");
    }

    // SECURITY: derive tenantId from the product, NOT from the request body.
    const product = await db.resellerProduct.findFirst({
      where: { id: productId, status: "active" },
      select: { tenantId: true },
    });

    if (!product) {
      throw new AppError("not_found", "Product not found or inactive", 404, "Product not found or inactive.");
    }

    // Phase 12.2 P0-7: Verify the product's tenant matches the caller's active tenant.
    if (product.tenantId !== ctx.tenantId) {
      throw new AppError("authorization", "Product does not belong to your active tenant", 403, "Product does not belong to your active tenant.");
    }

    const tenantId = ctx.tenantId;

    // Find or create the user
    let user = await db.user.findUnique({ where: { email } });
    if (!user) {
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
        data: { tenantId, userId: user.id, role: "viewer" },
      });
    }

    logger.info("commerce.customer_created", {
      userId: user.id,
      tenantId,
      productId,
      createdBy: authUser.id,
    });

    return apiSuccessResponse({ customer: { id: user.id, email: user.email, name: user.name } }, requestId);
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}
