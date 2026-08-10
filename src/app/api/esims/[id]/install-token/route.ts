import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createInstallToken } from "@/lib/esim/install-tokens";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** Generate a short-lived installation token for an eSIM (web→mobile deep link). */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const result = await createInstallToken(user.id, id);
    return json(result, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
