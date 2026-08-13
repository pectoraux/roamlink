/**
 * SaaS Subscription API.
 *   POST /api/tenant/saas/subscribe — create a subscription intent (choose plan + pay)
 *   POST /api/tenant/saas/confirm   — confirm payment (server-side verification)
 *   POST /api/tenant/saas/cancel    — cancel subscription (ends at period end)
 *   GET  /api/tenant/saas/invoices  — list invoice/receipt history
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { createSubscriptionIntent, confirmSubscriptionPayment, cancelSubscription, listTenantInvoices } from "@/lib/tenant/saas-subscription";
import { json, errorResponse } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);

    const body = await req.json();
    const { planName, billingCycle } = body;
    if (!planName) {
      return json({ error: "planName is required" }, 400);
    }

    const idempotencyKey = req.headers.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.length < 8) {
      return json({ error: "Idempotency-Key header is required (min 8 characters)" }, 400);
    }

    const result = await createSubscriptionIntent({
      tenantId: ctx.tenantId,
      userId: user.id,
      planName,
      billingCycle,
      idempotencyKey,
    });

    return json(result, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
