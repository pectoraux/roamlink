/**
 * Phase 5.1D — Reseller Onboarding API
 * POST /api/onboarding/tenant
 *
 * Public route for a new connectivity operator to sign up. Creates:
 *   1. A User (role: admin, owner of the tenant)
 *   2. A Tenant (the reseller's business)
 *   3. A TenantUser link (owner role)
 *   4. A TenantSubscription (trial — 14 days free, then requires payment)
 *
 * This is the self-service entry point that removes the need for manual
 * tenant creation. A new reseller can sign up, get a trial, and start
 * configuring their business without developer intervention.
 *
 * After signup, the reseller is redirected to the portal where they can:
 *   - Configure their business profile (brand name, color, domain)
 *   - Add their first connectivity provider (MikroTik router or eSIM supplier)
 *   - Create their first product
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/security";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { logger } from "@/lib/logger";
import { login, setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { email, password, name, businessName, businessSlug } = body;

  // Validate required fields
  if (!email || !password || !name || !businessName) {
    return NextResponse.json(
      { error: "Missing required fields: email, password, name, businessName" },
      { status: 400 },
    );
  }

  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 },
    );
  }

  // Check if the email is already registered
  const existingUser = await db.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json(
      { error: "An account with this email already exists. Please sign in instead." },
      { status: 409 },
    );
  }

  // Check if the slug is available
  const slug = businessSlug || businessName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const existingTenant = await db.tenant.findUnique({ where: { slug } });
  if (existingTenant) {
    return NextResponse.json(
      { error: `The business slug "${slug}" is already taken. Please choose another.` },
      { status: 409 },
    );
  }

  // Ensure SaaS plans exist
  await seedSaaasPlans();

  // Step 1: Create the user (admin role — they own the tenant)
  const user = await db.user.create({
    data: {
      email,
      name,
      passwordHash: await hashPassword(password),
      role: "admin",
    },
  });

  // Step 2: Create the tenant
  const tenant = await createTenant({ name: businessName, slug });

  // Step 3: Link the user to the tenant as owner
  await addTenantUser({ tenantId: tenant.id, userId: user.id, role: "owner" });

  // Step 4: Create a trial subscription (14 days free on the "starter" plan)
  const starterPlan = await db.saaasPlan.findUnique({ where: { name: "starter" } });
  if (starterPlan) {
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14);

    await db.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        saaasPlanId: starterPlan.id,
        status: "trialing",
        billingCycle: "monthly",
        currentPeriodEnd: trialEndsAt,
        trialEndsAt,
      },
    });
  }

  // Step 5: Create a TenantBalance (prepaid balance for supplier purchases)
  await db.tenantBalance.create({
    data: {
      tenantId: tenant.id,
      balanceMinor: 0,
      currency: "USD",
      totalDepositedMinor: 0,
      totalSpentMinor: 0,
      nextTransactionSequence: 0,
    },
  });

  logger.info("onboarding.tenant_created", {
    tenantId: tenant.id,
    userId: user.id,
    slug: tenant.slug,
  });

  // Step 6: Sign the user in (create a session)
  const { token } = await login({ email, password });
  await setSessionCookie(token);

  return NextResponse.json({
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    user: { id: user.id, email: user.email, name: user.name },
    redirectTo: "/portal/products/new",
  }, { status: 201 });
}
