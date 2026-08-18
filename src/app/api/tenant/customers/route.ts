/**
 * Tenant Customers API.
 *   GET    /api/tenant/customers       — list customers
 *   POST   /api/tenant/customers       — create customer
 *   GET    /api/tenant/customers/:id   — get customer
 *   PATCH  /api/tenant/customers/:id   — update customer
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_WRITE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { createTenantCustomer, listTenantCustomers, getTenantCustomer, updateTenantCustomer } from "@/lib/tenant/customers";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const customers = await listTenantCustomers(ctx.tenantId, { status, limit, offset });
    return json({ customers }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_WRITE_ROLES);
    const body = await req.json();
    const { name, email, phone, metadata } = body;
    // Phase 12.2 P1-4: Removed userId from client-supplied body — it was
    // an unvalidated cross-reference that could link a customer to an
    // arbitrary User. If user linking is needed, it should go through a
    // separate authenticated flow.
    if (!name || !email) {
      return json({ error: "name and email are required" }, 400);
    }
    const customer = await createTenantCustomer({
      tenantId: ctx.tenantId,
      name,
      email,
      phone,
      metadata,
    });
    return json({ customer }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
