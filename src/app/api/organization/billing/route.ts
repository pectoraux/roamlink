import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getUserOrganization, updateOrgBilling } from "@/server/services/organization";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** GET /api/organization/billing — get org billing settings. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const org = await getUserOrganization(user.id);
    if (!org) return json({ billing: null });
    return json({
      billing: {
        billingEmail: org.billingEmail,
        monthlySpendLimit: org.monthlySpendLimit,
        currentMonthSpend: org.currentMonthSpend,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/organization/billing — update billing settings. */
export async function PATCH(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const org = await getUserOrganization(user.id);
    if (!org) throw new AppError("not_found", "No organization", 404, "You don't have an organization.");
    const body = await req.json();
    await updateOrgBilling({
      organizationId: org.id,
      requesterId: user.id,
      billingEmail: body.billingEmail,
      monthlySpendLimit: body.monthlySpendLimit != null ? Number(body.monthlySpendLimit) : undefined,
    });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
