import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES } from "@/lib/tenant/context";
import { confirmSubscriptionPayment } from "@/lib/tenant/saas-subscription";
import { json, errorResponse } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);

    const body = await req.json();
    const { subscriptionId } = body;
    if (!subscriptionId) {
      return json({ error: "subscriptionId is required" }, 400);
    }

    const result = await confirmSubscriptionPayment({
      tenantId: ctx.tenantId,
      userId: user.id,
      subscriptionId,
    });

    return json(result, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
