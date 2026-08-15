/**
 * Phase 6.6 — Reseller Analytics API
 * GET /api/analytics/reseller
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { getResellerAnalytics } from "@/lib/analytics/reseller";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const days = parseInt(req.nextUrl.searchParams.get("days") || "30", 10);
  const analytics = await getResellerAnalytics(ctx.tenantId, days);

  return NextResponse.json({ analytics });
}
