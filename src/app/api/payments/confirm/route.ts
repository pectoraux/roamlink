import { NextRequest } from "next/server";
import { confirmAndProvision } from "@/lib/orders/service";
import { generateIdempotencyKey } from "@/lib/orders/idempotency";
import { getPaymentProvider, mockPaymentProvider } from "@/lib/payments";
import { getCurrentUser } from "@/lib/auth";
import { notify } from "@/lib/notifications/service";
import { json, errorResponse, getClientIP } from "@/lib/api";
import { AppError } from "@/lib/errors";

/**
 * Confirm a payment SERVER-SIDE and provision the eSIM.
 *
 * Two paths:
 *  - Mock provider: we simulate the provider's own confirmation (confirmIntent),
 *    then verify. This lets the full flow run without a real provider.
 *  - Real provider (PayStack/Flutterwave/Stripe): the customer has already
 *    completed payment on the provider's hosted page / SDK. We ONLY verify
 *    server-side — we never trust the client's claim of success.
 *
 * This is the single trusted entry point that triggers provisioning.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AppError("auth", "Not authenticated", 401, "Please sign in.");
    const body = await req.json();
    if (!body?.orderId) throw new AppError("validation", "Missing orderId", 400, "Order id is required.");

    // Mock: simulate the provider-side confirmation event (the "customer paid"
    // signal the real provider would send via webhook/redirect). For real
    // providers this step is absent — verification reads the truth from the
    // provider's API.
    const provider = getPaymentProvider();
    if (provider.isMock && body.paymentReference) {
      mockPaymentProvider.confirmIntent(body.paymentReference);
    }

    const idempotencyKey = body.idempotencyKey ?? generateIdempotencyKey("confirm");
    const result = await confirmAndProvision({ orderId: body.orderId, userId: user.id, idempotencyKey, ip: getClientIP(req) });

    if (result.status === "COMPLETED" && result.esimId) {
      await notify.paymentSuccessful(user.id, body.orderId, "");
      await notify.esimProvisioned(user.id, result.esimId, "");
    }
    return json({ ...result, idempotencyKey });
  } catch (err) {
    return errorResponse(err);
  }
}
