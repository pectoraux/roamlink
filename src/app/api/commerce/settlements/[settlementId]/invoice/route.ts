/**
 * Phase 7.2 — Generate Supplier Invoice
 * POST /api/commerce/settlements/[settlementId]/invoice
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { generateSupplierInvoice } from "@/lib/commerce/settlement";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ settlementId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const { settlementId } = await params;

  // Verify the settlement belongs to this tenant
  const settlement = await (await import("@/lib/db")).db.supplierSettlement.findFirst({
    where: { id: settlementId, tenantId: ctx.tenantId },
  });

  if (!settlement) {
    return NextResponse.json({ error: "Settlement not found" }, { status: 404 });
  }

  const result = await generateSupplierInvoice(settlementId);

  return NextResponse.json({ invoice: result });
}
