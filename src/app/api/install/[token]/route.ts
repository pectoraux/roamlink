import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { consumeInstallToken } from "@/lib/esim/install-tokens";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** Consume an installation token — returns eSIM activation details. Mobile app calls this. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { token } = await ctx.params;
    const result = await consumeInstallToken(user.id, token);
    return json({ esim: result });
  } catch (err) {
    return errorResponse(err);
  }
}
