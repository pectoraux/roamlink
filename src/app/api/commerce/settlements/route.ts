/**
 * Phase 7.2 — Settlement API
 * GET  /api/commerce/settlements — list settlements + payout history
 * POST /api/commerce/settlements — create a supplier settlement
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { createSupplierSettlement, getResellerSettlementSummary } from "@/lib/commerce/settlement";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const summary = await getResellerSettlementSummary(ctx.tenantId);

  return NextResponse.json({ summary });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { supplierId, periodStart, periodEnd } = body;

  if (!supplierId || !periodStart || !periodEnd) {
    return NextResponse.json(
      { error: "Missing required fields: supplierId, periodStart, periodEnd" },
      { status: 400 },
    );
  }

  const result = await createSupplierSettlement({
    tenantId: ctx.tenantId,
    supplierId,
    periodStart: new Date(periodStart),
    periodEnd: new Date(periodEnd),
  });

  return NextResponse.json({ settlement: result }, { status: 201 });
}
