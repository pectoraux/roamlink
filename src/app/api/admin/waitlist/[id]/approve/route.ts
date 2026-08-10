import { NextRequest } from "next/server";
import { requireAdmin, approveWaitlistEntry } from "@/lib/auth";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** Approve a waitlist entry and create a real user account. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const body = await req.json();
    if (!body?.password) throw new AppError("validation", "Missing password", 400, "Set a password for the new account.");
    const result = await approveWaitlistEntry({
      waitlistId: id,
      adminId: admin.id,
      password: body.password,
      name: body.name,
    });
    return json({ userId: result.userId, email: result.email, message: "Account created." }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
