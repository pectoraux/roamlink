/**
 * Phase 3 — Product Catalog API
 * POST /api/commerce/products — create a product
 * GET  /api/commerce/products — list products for the tenant
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const products = await db.resellerProduct.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ products });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { name, description, capabilityType, providerType, priceMinor, currency, billingCycle, capabilitySet } = body;

  if (!name || !capabilityType || !capabilitySet) {
    return NextResponse.json(
      { error: "Missing required fields: name, capabilityType, capabilitySet" },
      { status: 400 },
    );
  }

  const product = await db.resellerProduct.create({
    data: {
      tenantId: ctx.tenantId,
      name,
      description: description ?? null,
      capabilityType,
      providerType: providerType ?? null,
      pricingModel: "FLAT",
      priceMinor: priceMinor ?? 0,
      currency: currency ?? "USD",
      billingCycle: billingCycle ?? "one_time",
      capabilitySet: typeof capabilitySet === "string" ? capabilitySet : JSON.stringify(capabilitySet),
      status: "active",
    },
  });

  return NextResponse.json({ product }, { status: 201 });
}
