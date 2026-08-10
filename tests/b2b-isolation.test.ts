/**
 * B2B tenant isolation tests.
 * Verifies Organization A cannot access Organization B's resources.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import {
  createOrganization,
  getUserOrganization,
  addMember,
  assertOrgRole,
} from "@/server/services/organization";
import { expectReject } from "./helpers";
import { ensureTestSetup } from "./setup";
import { hashPassword } from "@/lib/security";
import { AppError } from "@/lib/errors";

let orgA_ownerId: string;
let orgB_ownerId: string;
let orgA_id: string;
let orgB_id: string;
let setupDone = false;

/** Lazy setup — runs once on first test, avoids beforeAll 5s timeout limit. */
async function ensureOrgSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();

  // Create two users (org owners)
  const ownerA = await db.user.create({
    data: { email: `org-a-owner-${Date.now()}@roamlink.test`, name: "Org A Owner", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  const ownerB = await db.user.create({
    data: { email: `org-b-owner-${Date.now()}@roamlink.test`, name: "Org B Owner", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  orgA_ownerId = ownerA.id;
  orgB_ownerId = ownerB.id;

  // Create two organizations
  const orgA = await createOrganization({ name: `Org A ${Date.now()}`, ownerId: orgA_ownerId });
  const orgB = await createOrganization({ name: `Org B ${Date.now()}`, ownerId: orgB_ownerId });
  orgA_id = orgA.id;
  orgB_id = orgB.id;
}

afterAll(async () => {
  // Clean up
  if (orgA_id && orgB_id) {
    await db.organizationMember.deleteMany({ where: { organizationId: { in: [orgA_id, orgB_id] } } });
    await db.organizationESIM.deleteMany({ where: { organizationId: { in: [orgA_id, orgB_id] } } });
    await db.corporateOrder.deleteMany({ where: { organizationId: { in: [orgA_id, orgB_id] } } });
    await db.organization.deleteMany({ where: { id: { in: [orgA_id, orgB_id] } } });
    await db.user.deleteMany({ where: { id: { in: [orgA_ownerId, orgB_ownerId] } } });
  }
  await db.$disconnect();
});

describe("B2B tenant isolation", () => {
  it("each owner sees only their own organization", async () => {
    await ensureOrgSetup();
    const orgA = await getUserOrganization(orgA_ownerId);
    const orgB = await getUserOrganization(orgB_ownerId);

    expect(orgA?.id).toBe(orgA_id);
    expect(orgB?.id).toBe(orgB_id);
    expect(orgA?.id).not.toBe(orgB?.id);
  }, 60000);

  it("Org A owner cannot assert role in Org B", async () => {
    await ensureOrgSetup();
    // Org A owner tries to act as admin in Org B
    await expectReject(() => assertOrgRole(orgB_id, orgA_ownerId, ["owner", "admin"]), AppError);
  }, 60000);

  it("Org B owner cannot assert role in Org A", async () => {
    await ensureOrgSetup();
    await expectReject(() => assertOrgRole(orgA_id, orgB_ownerId, ["owner", "admin"]), AppError);
  }, 60000);

  it("non-members cannot assert any role", async () => {
    await ensureOrgSetup();
    // Create a random user who is not a member of any org
    const outsider = await db.user.create({
      data: { email: `outsider-${Date.now()}@roamlink.test`, name: "Outsider", passwordHash: await hashPassword("test12345"), role: "customer" },
    });

    await expectReject(() => assertOrgRole(orgA_id, outsider.id, ["owner", "admin", "member"]), AppError);

    await db.user.delete({ where: { id: outsider.id } });
  }, 60000);

  it("owner can add a member and the member can assert their role", async () => {
    await ensureOrgSetup();
    // Org A owner adds a member
    const member = await db.user.create({
      data: { email: `org-a-member-${Date.now()}@roamlink.test`, name: "Org A Member", passwordHash: await hashPassword("test12345"), role: "customer" },
    });

    await addMember({
      organizationId: orgA_id,
      requesterId: orgA_ownerId,
      userId: member.id,
      role: "member",
    });

    // Member can assert their role in Org A
    await expect(
      assertOrgRole(orgA_id, member.id, ["member"])
    ).resolves.toBeUndefined();

    // But member cannot assert admin/owner role
    await expectReject(() => assertOrgRole(orgA_id, member.id, ["owner", "admin"]), AppError);

    // Member cannot access Org B at all
    await expectReject(() => assertOrgRole(orgB_id, member.id, ["member"]), AppError);

    await db.organizationMember.deleteMany({ where: { userId: member.id } });
    await db.user.delete({ where: { id: member.id } });
  }, 60000);

  it("a member of Org A is not automatically a member of Org B", async () => {
    await ensureOrgSetup();
    const member = await db.user.create({
      data: { email: `cross-org-${Date.now()}@roamlink.test`, name: "Cross Org", passwordHash: await hashPassword("test12345"), role: "customer" },
    });

    // Add to Org A only
    await addMember({
      organizationId: orgA_id,
      requesterId: orgA_ownerId,
      userId: member.id,
      role: "member",
    });

    // getUserOrganization returns Org A (the one they're a member of)
    const org = await getUserOrganization(member.id);
    expect(org?.id).toBe(orgA_id);

    // Not a member of Org B
    await expectReject(() => assertOrgRole(orgB_id, member.id, ["member"]), AppError);

    await db.organizationMember.deleteMany({ where: { userId: member.id } });
    await db.user.delete({ where: { id: member.id } });
  }, 60000);
});
