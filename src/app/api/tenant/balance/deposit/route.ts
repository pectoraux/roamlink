/**
 * Tenant Balance Deposit API.
 *   POST /api/tenant/balance/deposit — create a deposit intent + confirm payment
 *
 * Phase 2B.2: Balance is ONLY credited after a real payment event.
 * Creates a TenantDepositPayment + payment provider intent, then verifies
 * the payment server-side before crediting the balance.
 *
 * In production (NODE_ENV=production), the mock provider is blocked.
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES } from "@/lib/tenant/context";
import { createDepositIntent, confirmDepositPayment } from "@/lib/tenant/balance";
import { json, errorResponse } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);

    const body = await req.json();
    const { amountMinor, idempotencyKey, confirm } = body;

    if (typeof amountMinor !== "number" || amountMinor <= 0) {
      return json({ error: "amountMinor must be a positive number" }, 400);
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return json({ error: "idempotencyKey is required" }, 400);
    }

    // Step 1: Create the deposit intent (creates a payment provider intent)
    const intent = await createDepositIntent({
      tenantId: ctx.tenantId,
      userId: user.id,
      amountMinor,
      idempotencyKey,
    });

    // Step 2: If confirm=true (or the mock provider auto-succeeds), verify + credit
    // In a real production flow, the client would complete the payment on the
    // provider's side, then a webhook would trigger confirmDepositPayment.
    // For the mock provider (development only), we can confirm immediately.
    if (confirm !== false) {
      const result = await confirmDepositPayment({
        depositPaymentId: intent.depositPaymentId,
        tenantId: ctx.tenantId,
        userId: user.id,
      });

      return json({
        depositPaymentId: intent.depositPaymentId,
        providerReference: intent.providerReference,
        status: result.status,
        balanceMinor: result.balanceMinor,
      }, 201);
    }

    // Return the intent for the client to complete payment
    return json({
      depositPaymentId: intent.depositPaymentId,
      providerReference: intent.providerReference,
      status: intent.status,
      clientSecret: intent.clientSecret,
    }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
