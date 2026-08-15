/**
 * Phase 6.1 — Payout API
 * GET  /api/commerce/payouts — list payouts
 * POST /api/commerce/payouts — request a payout
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { requireTenantContext } from "@/lib/tenant/context";
import { requestPayout } from "@/lib/commerce/reseller-economics";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const payouts = await db.resellerPayout.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ payouts });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await requireTenantContext(user);

  const body = await req.json();
  const { amountMinor, method, destinationRef } = body;

  if (!amountMinor || amountMinor <= 0) {
    return NextResponse.json({ error: "amountMinor must be positive" }, { status: 400 });
  }

  if (!method || !["bank_transfer", "mobile_money", "stripe_transfer"].includes(method)) {
    return NextResponse.json({ error: "Invalid method" }, { status: 400 });
  }

  try {
    const result = await requestPayout({
      tenantId: ctx.tenantId,
      amountMinor,
      method,
      destinationRef,
    });

    return NextResponse.json({ payout: result }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to request payout" },
      { status: 400 },
    );
  }
}
