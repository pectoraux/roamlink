import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { listTenantInvoices } from "@/lib/tenant/saas-subscription";
import { json, errorResponse } from "@/lib/api";

export async function GET() {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const invoices = await listTenantInvoices(ctx.tenantId);
    return json({ invoices }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
