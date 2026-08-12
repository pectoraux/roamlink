import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getUserOrganization, updateMember, removeMember } from "@/server/services/organization";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** PATCH /api/organization/members/[id] — update member role/spend limit. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const org = await getUserOrganization(user.id);
    if (!org) throw new AppError("not_found", "No organization", 404, "You don't have an organization.");
    const { id: memberUserId } = await ctx.params;
    const body = await req.json();
    await updateMember({
      organizationId: org.id,
      requesterId: user.id,
      memberUserId,
      role: body.role,
      spendLimit: body.spendLimit != null ? Number(body.spendLimit) : undefined,
    });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/organization/members/[id] — remove member. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const org = await getUserOrganization(user.id);
    if (!org) throw new AppError("not_found", "No organization", 404, "You don't have an organization.");
    const { id: memberUserId } = await ctx.params;
    await removeMember({
      organizationId: org.id,
      requesterId: user.id,
      memberUserId,
    });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
