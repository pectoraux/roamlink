import { NextRequest } from "next/server";
import { createOrder, listUserOrders } from "@/lib/orders/service";
import { generateIdempotencyKey } from "@/lib/orders/idempotency";
import { getCurrentUser } from "@/lib/auth";
import { json, errorResponse, getClientIP } from "@/lib/api";
import { AppError } from "@/lib/errors";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const orders = await listUserOrders(user.id);
    return json({ orders });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in to purchase.");
    const body = await req.json();
    if (!body?.planId) throw new AppError("validation", "Missing planId", 400, "Please choose a plan.");
    // Client may supply idempotencyKey for retries; else generate one.
    const idempotencyKey = body.idempotencyKey ?? generateIdempotencyKey("checkout");
    const order = await createOrder({ userId: user.id, planId: body.planId, idempotencyKey, ip: getClientIP(req) });
    return json({ order, idempotencyKey }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
