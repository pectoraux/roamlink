/**
 * Phase 6.1 — Reseller Balance API
 * GET /api/commerce/balance
 *
 * Returns the reseller's current financial position:
 *   totalEarnings, totalProviderCosts, pendingPayouts, completedPayouts, available
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { getResellerBalance } from "@/lib/commerce/reseller-economics";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const balance = await getResellerBalance(ctx.tenantId);

  return NextResponse.json({ balance });
}
