/**
 * Tenant API Keys API.
 *   GET   /api/tenant/api-keys       — list keys (without secrets)
 *   POST  /api/tenant/api-keys       — create key (returns raw key ONCE)
 *   DELETE /api/tenant/api-keys/:id  — revoke key
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { requireTenantContext, requireTenantRole, TENANT_MANAGE_ROLES, TENANT_VIEW_ROLES } from "@/lib/tenant/context";
import { db } from "@/lib/db";
import { audit } from "@/lib/orders/idempotency";
import { json, errorResponse } from "@/lib/api";
import { randomBytes, createHash } from "crypto";
import { AppError } from "@/lib/errors";

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export async function GET() {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_VIEW_ROLES);
    const keys = await db.apiKey.findMany({
      where: { tenantId: ctx.tenantId, revokedAt: null },
      select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    return json({ keys }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ctx = await requireTenantContext(user);
    requireTenantRole(ctx, TENANT_MANAGE_ROLES);
    const body = await req.json();
    const { name, scopes } = body;
    if (!name) return json({ error: "name is required" }, 400);

    const rawKey = `rlk_${randomBytes(24).toString("hex")}`;
    const hashedKey = hashKey(rawKey);
    const prefix = rawKey.slice(0, 12);
    const scopesStr = scopes ? JSON.stringify(scopes) : JSON.stringify(["read"]);

    const apiKey = await db.apiKey.create({
      data: {
        tenantId: ctx.tenantId,
        name,
        hashedKey,
        prefix,
        scopes: scopesStr,
        createdBy: user.id,
      },
    });
    await audit({
      tenantId: ctx.tenantId,
      userId: user.id,
      action: "api_key.created",
      entity: "api_key",
      entityId: apiKey.id,
      detail: { name, prefix },
    });
    // Return the raw key ONCE — only the hash is stored
    return json({ id: apiKey.id, key: rawKey, name, prefix }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
