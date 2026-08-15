/**
 * Phase 3 — Customer find-or-create API
 * POST /api/commerce/customer
 *
 * Finds an existing user by email, or creates a new one with role "customer".
 * This is used by the checkout flow — the customer doesn't need to sign up
 * separately; entering their email at checkout is enough.
 *
 * The user is linked to the tenant via TenantUser so the reseller can see
 * their customers.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/security";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { email, name, tenantId } = body;

  if (!email || !tenantId) {
    return NextResponse.json(
      { error: "Missing required fields: email, tenantId" },
      { status: 400 },
    );
  }

  // Find or create the user
  let user = await db.user.findUnique({
    where: { email },
  });

  if (!user) {
    // Create a new customer user with a random password (they'll reset it later)
    const randomPassword = Math.random().toString(36).slice(2) + Date.now().toString(36);
    user = await db.user.create({
      data: {
        email,
        name: name ?? null,
        passwordHash: await hashPassword(randomPassword),
        role: "customer",
      },
    });
  }

  // Link the user to the tenant (if not already linked)
  const existingMembership = await db.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId, userId: user.id } },
  });

  if (!existingMembership) {
    await db.tenantUser.create({
      data: {
        tenantId,
        userId: user.id,
        role: "viewer", // customers have viewer role in the tenant context
      },
    });
  }

  return NextResponse.json({ customer: { id: user.id, email: user.email, name: user.name } });
}
