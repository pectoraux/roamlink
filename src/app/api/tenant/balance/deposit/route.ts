/**
 * POST /api/tenant/balance/deposit — add prepaid funds to the reseller balance.
 *
 * Phase 2B.1: In production, this would integrate with a real payment provider
 * (Stripe/Paystack) to collect funds. For now, it records the deposit and posts
 * to the canonical ledger (Dr Cash, Cr Reseller Funds Liability).
 *
 * The idempotency key prevents duplicate deposits from network retries.
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES } from "@/lib/tenant/context";
import { depositResellerBalance } from "@/lib/tenant/balance";
import { json, errorResponse } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);

    const body = await req.json();
    const { amountMinor, idempotencyKey } = body;

    if (typeof amountMinor !== "number" || amountMinor <= 0) {
      return json({ error: "amountMinor must be a positive number" }, 400);
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return json({ error: "idempotencyKey is required" }, 400);
    }

    const result = await depositResellerBalance({
      tenantId: ctx.tenantId,
      userId: user.id,
      amountMinor,
      idempotencyKey,
      description: "Prepaid deposit via API",
    });

    return json(result, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
