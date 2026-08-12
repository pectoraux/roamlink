import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getUserSubscriptions, cancelSubscription } from "@/lib/subscriptions/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** GET /api/subscriptions — list user's subscriptions. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const subs = await getUserSubscriptions(user.id);
    return json({ subscriptions: subs });
  } catch (err) {
    return errorResponse(err);
  }
}
