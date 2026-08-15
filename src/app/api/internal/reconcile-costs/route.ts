/**
 * Phase 6.1 — Provider Cost Reconciliation API
 * POST /api/internal/reconcile-costs
 *
 * Settles pending ProviderCost records older than N days.
 * Called by a cron job (or manually by an admin).
 *
 * Protected by CRON_SECRET env var.
 */

import { NextRequest, NextResponse } from "next/server";
import { settlePendingProviderCosts } from "@/lib/commerce/reseller-economics";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const result = await settlePendingProviderCosts({
    tenantId: body.tenantId,
    olderThanDays: body.olderThanDays ?? 7,
  });

  return NextResponse.json(result);
}
