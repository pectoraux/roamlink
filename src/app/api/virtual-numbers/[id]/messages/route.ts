import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getMessages, sendSMS } from "@/lib/virtual-numbers/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** GET /api/virtual-numbers/[id]/messages — list messages. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const messages = await getMessages(user.id, id);
    return json({ messages });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/virtual-numbers/[id]/messages — send SMS. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const { id } = await ctx.params;
    const body = await req.json();
    if (!body?.to || !body?.body) throw new AppError("validation", "Missing fields", 400, "Recipient and message body are required.");
    const message = await sendSMS(user.id, id, body.to, body.body);
    return json({ message }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
