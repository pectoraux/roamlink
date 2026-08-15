/**
 * Phase 6.6 — Platform Analytics API
 * GET /api/analytics/platform (admin-only)
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, requireAdmin } from "@/lib/auth";
import { getPlatformAnalytics } from "@/lib/analytics/platform";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  requireAdmin();

  const days = parseInt(req.nextUrl.searchParams.get("days") || "30", 10);
  const analytics = await getPlatformAnalytics(days);

  return NextResponse.json({ analytics });
}
