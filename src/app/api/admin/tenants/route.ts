/**
 * Admin Tenant Management API.
 *   GET  /api/admin/tenants        — list all tenants
 *   POST /api/admin/tenants        — create a new tenant (+ seed free subscription)
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createTenant } from "@/lib/tenant/service";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { db } from "@/lib/db";
import { json, errorResponse } from "@/lib/api";

export async function GET() {
  try {
    await requireAdmin();
    const tenants = await db.tenant.findMany({
      include: {
        _count: { select: { users: true, customers: true, orders: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return json({ tenants }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json();
    const { name, slug, brandName, billingEmail, ownerId, defaultMarkupPercent } = body;
    if (!name) return json({ error: "name is required" }, 400);

    // Ensure SaaS plans exist
    await seedSaaasPlans();

    const tenant = await createTenant({
      name,
      slug,
      brandName,
      billingEmail,
      defaultMarkupPercent,
    });

    // If an ownerId is provided, add them as the tenant owner
    if (ownerId) {
      await db.tenantUser.create({
        data: { tenantId: tenant.id, userId: ownerId, role: "owner" },
      });
    }

    // Create a free-tier subscription for the tenant
    const freePlan = await db.saaasPlan.findUnique({ where: { name: "free" } });
    if (freePlan) {
      await db.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          saaasPlanId: freePlan.id,
          status: "active",
          billingCycle: "monthly",
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    }

    return json({ tenant, apiKey: tenant.apiKey }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
