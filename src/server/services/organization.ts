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

/** Get org stats: member count, eSIM count, order count, number count, spend. */
export async function getOrgStats(organizationId: string) {
  const [members, esims, orders, numbers, org] = await Promise.all([
    db.organizationMember.count({ where: { organizationId } }),
    db.organizationESIM.count({ where: { organizationId } }),
    db.corporateOrder.count({ where: { organizationId } }),
    db.virtualNumber.count({ where: { organizationId } }),
    db.organization.findUnique({ where: { id: organizationId } }),
  ]);
  return {
    members,
    esims,
    orders,
    numbers,
    monthlySpendLimit: org?.monthlySpendLimit ?? 0,
    currentMonthSpend: org?.currentMonthSpend ?? 0,
  };
}

/** Check if a member can spend a given amount. Throws if over limit. */
export async function checkSpendLimit(organizationId: string, userId: string, amountMinor: number): Promise<void> {
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!member) throw new AppError("authorization", "Not a member", 403, "You are not a member of this organization.");

  // -1 = no purchases allowed
  if (member.spendLimit === -1) {
    throw new AppError("authorization", "Purchases disabled", 403, "Your purchasing privileges have been disabled.");
  }

  // Check per-member limit (0 = use org default, which may also be 0 = unlimited)
  if (member.spendLimit > 0 && member.currentSpend + amountMinor > member.spendLimit) {
    throw new AppError("authorization", "Member spend limit exceeded", 403, `This purchase would exceed your monthly spending limit of ${(member.spendLimit / 100).toFixed(2)}.`);
  }

  // Check org-level limit
  const org = await db.organization.findUnique({ where: { id: organizationId } });
  if (org && org.monthlySpendLimit > 0 && org.currentMonthSpend + amountMinor > org.monthlySpendLimit) {
    throw new AppError("authorization", "Org spend limit exceeded", 403, `This purchase would exceed the organization's monthly spending limit.`);
  }
}

/** Record a spend against org + member limits. Called after a successful purchase. */
export async function recordOrgSpend(organizationId: string, userId: string, amountMinor: number): Promise<void> {
  await db.$transaction([
    db.organization.update({
      where: { id: organizationId },
      data: { currentMonthSpend: { increment: amountMinor } },
    }),
    db.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { currentSpend: { increment: amountMinor } },
    }),
  ]);
  logger.info("org.spend_recorded", { organizationId, userId, amount: amountMinor });
}

/** Remove a member from the organization. Owners can't be removed. */
export async function removeMember(input: {
  organizationId: string;
  requesterId: string;
  memberUserId: string;
}): Promise<void> {
  await assertOrgRole(input.organizationId, input.requesterId, ["owner", "admin"]);

  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: input.organizationId, userId: input.memberUserId } },
  });
  if (!member) throw new AppError("not_found", "Member not found", 404, "Member not found.");
  if (member.role === "owner") throw new AppError("conflict", "Cannot remove owner", 409, "Organization owners cannot be removed.");

  await db.organizationMember.delete({
    where: { id: member.id },
  });
  await audit({ userId: input.requesterId, action: "org.member_removed", entity: "organization", entityId: input.organizationId, detail: { memberUserId: input.memberUserId } });
  logger.info("org.member_removed", { organizationId: input.organizationId, memberUserId: input.memberUserId });
}

/** Update a member's role or spending limit. */
export async function updateMember(input: {
  organizationId: string;
  requesterId: string;
  memberUserId: string;
  role?: "owner" | "admin" | "member";
  spendLimit?: number;
}): Promise<void> {
  await assertOrgRole(input.organizationId, input.requesterId, ["owner", "admin"]);

  const data: Record<string, unknown> = {};
  if (input.role) data.role = input.role;
  if (input.spendLimit != null) data.spendLimit = input.spendLimit;

  await db.organizationMember.update({
    where: { organizationId_userId: { organizationId: input.organizationId, userId: input.memberUserId } },
    data,
  });
  await audit({ userId: input.requesterId, action: "org.member_updated", entity: "organization", entityId: input.organizationId, detail: { memberUserId: input.memberUserId, role: input.role, spendLimit: input.spendLimit } });
}

/** Assign a virtual number to an organization. */
export async function assignNumber(input: {
  organizationId: string;
  requesterId: string;
  virtualNumberId: string;
}): Promise<void> {
  await assertOrgRole(input.organizationId, input.requesterId, ["owner", "admin"]);
  await db.virtualNumber.update({
    where: { id: input.virtualNumberId },
    data: { organizationId: input.organizationId },
  });
  await audit({ userId: input.requesterId, action: "org.number_assigned", entity: "organization", entityId: input.organizationId, detail: { virtualNumberId: input.virtualNumberId } });
}

/** Get org usage summary — eSIM data usage + number SMS/calls. */
export async function getOrgUsage(organizationId: string) {
  const [orgEsims, orgNumbers] = await Promise.all([
    db.organizationESIM.findMany({
      where: { organizationId },
      include: { esim: { include: { order: { include: { plan: true } } } } },
    }),
    db.virtualNumber.findMany({
      where: { organizationId },
      include: { _count: { select: { messages: true, calls: true } } },
    }),
  ]);

  const esimUsage = orgEsims.map((oe) => ({
    id: oe.esim.id,
    country: oe.esim.order.plan.country,
    dataAmount: oe.esim.dataAmount,
    dataRemaining: oe.esim.dataRemaining,
    status: oe.esim.status,
    assignedTo: oe.assignedTo,
  }));

  const numberUsage = orgNumbers.map((vn) => ({
    id: vn.id,
    e164: vn.e164,
    country: vn.country,
    status: vn.status,
    messageCount: vn._count.messages,
    callCount: vn._count.calls,
  }));

  return { esims: esimUsage, numbers: numberUsage };
}

/** Update org billing settings. */
export async function updateOrgBilling(input: {
  organizationId: string;
  requesterId: string;
  billingEmail?: string;
  monthlySpendLimit?: number;
}): Promise<void> {
  await assertOrgRole(input.organizationId, input.requesterId, ["owner", "admin"]);
  const data: Record<string, unknown> = {};
  if (input.billingEmail != null) data.billingEmail = input.billingEmail;
  if (input.monthlySpendLimit != null) data.monthlySpendLimit = input.monthlySpendLimit;
  await db.organization.update({ where: { id: input.organizationId }, data });
  await audit({ userId: input.requesterId, action: "org.billing_updated", entity: "organization", entityId: input.organizationId, detail: data });
}
