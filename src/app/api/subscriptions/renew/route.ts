import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { renewSubscription } from "@/lib/subscriptions/service";
import { json, errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** POST /api/subscriptions/renew — manually renew a subscription (for testing). */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const body = await req.json();
    if (!body?.subscriptionId) throw new AppError("validation", "Missing subscriptionId", 400, "Subscription ID is required.");
    const result = await renewSubscription(body.subscriptionId);
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
