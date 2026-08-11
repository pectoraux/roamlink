import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getUserOrganization, getOrgUsage } from "@/server/services/organization";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** GET /api/organization/usage — org-wide usage summary. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const org = await getUserOrganization(user.id);
    if (!org) return json({ esims: [], numbers: [] });
    const usage = await getOrgUsage(org.id);
    return json(usage);
  } catch (err) {
    return errorResponse(err);
  }
}
