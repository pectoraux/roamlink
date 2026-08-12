/**
 * Tenant Balance API.
 *   GET  /api/tenant/balance          — get current balance + recent transactions
 *   POST /api/tenant/balance/deposit  — add prepaid funds (reseller deposits money)
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { getOrCreateTenantBalance, depositResellerBalance, listTenantTransactions } from "@/lib/tenant/balance";
import { json, errorResponse } from "@/lib/api";

export async function GET() {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const [balance, transactions] = await Promise.all([
      getOrCreateTenantBalance(ctx.tenantId),
      listTenantTransactions(ctx.tenantId, 20),
    ]);
    return json({ balance, transactions }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
