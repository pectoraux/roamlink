/**
 * Organization service — B2B foundation.
 *
 * Organizations can have members (owner/admin/member roles), assign eSIMs to
 * employees, and place corporate orders. This is a foundation — not all
 * features are implemented yet.
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";

/** Create a new organization. The creator becomes the owner. */
export async function createOrganization(input: {
  name: string;
  ownerId: string;
}): Promise<{ id: string; name: string; slug: string }> {
  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const existing = await db.organization.findUnique({ where: { slug } });
  if (existing) throw new AppError("conflict", "Slug taken", 409, "An organization with a similar name already exists.");

  const org = await db.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: input.name, slug } });
    await tx.organizationMember.create({
      data: { organizationId: org.id, userId: input.ownerId, role: "owner" },
    });
    return org;
  });

  await audit({ userId: input.ownerId, action: "org.created", entity: "organization", entityId: org.id, detail: { name: input.name } });
  logger.info("org.created", { orgId: org.id, ownerId: input.ownerId });
  return { id: org.id, name: org.name, slug: org.slug };
}

/** Get the user's organization (first org they're a member of). */
export async function getUserOrganization(userId: string) {
  const membership = await db.organizationMember.findFirst({
    where: { userId },
    include: { organization: { include: { members: { include: { user: { select: { id: true, email: true, name: true } } } }, esims: true, orders: true } } },
  });
  if (!membership) return null;
  return { ...membership.organization, role: membership.role };
}

/** Add a member to an organization. Only owners/admins can do this. */
export async function addMember(input: {
  organizationId: string;
  requesterId: string;
  userId: string;
  role?: "owner" | "admin" | "member";
}): Promise<void> {
  await assertOrgRole(input.organizationId, input.requesterId, ["owner", "admin"]);
  const role = input.role ?? "member";
  await db.organizationMember.create({
    data: { organizationId: input.organizationId, userId: input.userId, role },
  });
  await audit({ userId: input.requesterId, action: "org.member_added", entity: "organization", entityId: input.organizationId, detail: { userId: input.userId, role } });
}

/** Assign an eSIM to an organization + employee. */
export async function assignESIM(input: {
  organizationId: string;
  requesterId: string;
  esimId: string;
  assignedTo?: string;
}): Promise<void> {
  await assertOrgRole(input.organizationId, input.requesterId, ["owner", "admin"]);
  await db.organizationESIM.create({
    data: { organizationId: input.organizationId, esimId: input.esimId, assignedTo: input.assignedTo ?? null },
  });
  await audit({ userId: input.requesterId, action: "org.esim_assigned", entity: "organization", entityId: input.organizationId, detail: { esimId: input.esimId, assignedTo: input.assignedTo } });
}

/** Assert the user has one of the required roles in the organization. */
export async function assertOrgRole(organizationId: string, userId: string, roles: string[]): Promise<void> {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!membership || !roles.includes(membership.role)) {
    throw new AppError("authorization", "Insufficient org role", 403, "You don't have permission to perform this action.");
  }
}

/** Get org stats: member count, eSIM count, order count. */
export async function getOrgStats(organizationId: string) {
  const [members, esims, orders] = await Promise.all([
    db.organizationMember.count({ where: { organizationId } }),
    db.organizationESIM.count({ where: { organizationId } }),
    db.corporateOrder.count({ where: { organizationId } }),
  ]);
  return { members, esims, orders };
}
