/**
 * Tenant Catalog API.
 *   GET   /api/tenant/catalog        — list available products + tenant's distribution offers
 *   POST  /api/tenant/catalog        — enable a product (create/update DistributionOffer)
 *   PATCH /api/tenant/catalog/:id    — update/disable a distribution offer
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_WRITE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { listAvailableProducts, enableProduct, disableProduct, getTenantCatalog, getOfferEconomics } from "@/lib/tenant/catalog";
import { json, errorResponse } from "@/lib/api";

export async function GET() {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const [products, catalog] = await Promise.all([
      listAvailableProducts(ctx.tenantId),
      getTenantCatalog(ctx.tenantId),
    ]);
    return json({ products, catalog }, 200);
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
    const { productId, retailPriceMinor, audience } = body;
    if (!productId || typeof retailPriceMinor !== "number") {
      return json({ error: "productId and retailPriceMinor are required" }, 400);
    }
    const offer = await enableProduct({
      tenantId: ctx.tenantId,
      productId,
      retailPriceMinor,
      audience,
    });
    return json({ offer }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
