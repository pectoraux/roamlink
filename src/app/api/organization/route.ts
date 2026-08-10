import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createOrganization, getUserOrganization } from "@/server/services/organization";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** Get the current user's organization. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const org = await getUserOrganization(user.id);
    return json({ organization: org });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Create a new organization (creator becomes owner). */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const body = await req.json();
    if (!body?.name) throw new AppError("validation", "Missing name", 400, "Organization name is required.");
    const org = await createOrganization({ name: body.name, ownerId: user.id });
    return json({ organization: org }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
