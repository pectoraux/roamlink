/**
 * Phase 4 — Reseller Markup API
 * GET  /api/commerce/markup — list markup rules
 * POST /api/commerce/markup — create/update a markup rule
 *
 * Markup rules determine the customer-facing price of supplier offers.
 * The reseller can set a global default and override per-capability,
 * per-provider, or per-supplier.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const markups = await db.resellerMarkup.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ markups });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { capabilityType, providerType, supplierId, markupPercent, markupFixedMinor } = body;

  // Upsert: if a rule with the same scope exists, update it; otherwise create.
  const existing = await db.resellerMarkup.findFirst({
    where: {
      tenantId: ctx.tenantId,
      capabilityType: capabilityType ?? null,
      providerType: providerType ?? null,
      supplierId: supplierId ?? null,
    },
  });

  let markup;
  if (existing) {
    markup = await db.resellerMarkup.update({
      where: { id: existing.id },
      data: {
        markupPercent: markupPercent ?? 0,
        markupFixedMinor: markupFixedMinor ?? 0,
      },
    });
  } else {
    markup = await db.resellerMarkup.create({
      data: {
        tenantId: ctx.tenantId,
        capabilityType: capabilityType ?? null,
        providerType: providerType ?? null,
        supplierId: supplierId ?? null,
        markupPercent: markupPercent ?? 0,
        markupFixedMinor: markupFixedMinor ?? 0,
      },
    });
  }

  return NextResponse.json({ markup });
}
