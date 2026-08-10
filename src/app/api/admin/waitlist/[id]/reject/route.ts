import { NextRequest } from "next/server";
import { requireAdmin, rejectWaitlistEntry } from "@/lib/auth";
import { json, errorResponse } from "@/lib/api";

/** Reject a waitlist entry (no account created). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    await rejectWaitlistEntry({ waitlistId: id, adminId: admin.id, note: body?.note });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
