/**
 * GET /api/tenant/me — returns the current tenant context + entitlements.
 */

import { getCurrentUser } from "@/lib/auth";
import { getActiveTenant, listUserTenants } from "@/lib/tenant/context";
import { getTenantEntitlements } from "@/lib/tenant/entitlements";
import { getTenantCustomerStats } from "@/lib/tenant/customers";
import { json, errorResponse } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return json({ tenant: null, tenants: [] }, 200);

    const tenants = await listUserTenants(user.id);
    const ctx = await getActiveTenant(user);

    if (!ctx) {
      return json({ tenant: null, tenants, entitlements: null }, 200);
    }

    const [entitlements, customerStats, orderCount, activeServices] = await Promise.all([
      getTenantEntitlements(ctx.tenantId),
      getTenantCustomerStats(ctx.tenantId),
      db.order.count({ where: { tenantId: ctx.tenantId } }),
      db.esim.count({ where: { order: { tenantId: ctx.tenantId } } }).catch(() => 0),
    ]);

    return json({
      tenant: {
        id: ctx.tenant.id,
        name: ctx.tenant.name,
        slug: ctx.tenant.slug,
        role: ctx.role,
      },
      tenants,
      entitlements,
      stats: {
        customers: customerStats,
        orders: orderCount,
        activeServices,
      },
    }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
