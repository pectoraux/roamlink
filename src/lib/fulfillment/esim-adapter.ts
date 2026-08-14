/**
 * ESIM Fulfillment Adapter — wraps an ESIMProvider instance behind the
 * generic FulfillmentAdapter interface.
 *
 * Phase 2E P0 FIX: The adapter receives a CONCRETE ESIMProvider instance
 * at construction time — NOT a providerKey that later resolves to a global
 * getESIMProvider() singleton. Multiple adapters can coexist, each bound
 * to a different upstream provider instance.
 *
 * The purchase path NEVER calls getESIMProvider(). Provider selection is
 * driven by Supplier.providerKey → registry → adapter → provider instance.
 */

import type { ESIMProvider } from "@/lib/esim/provider";
import type {
  FulfillmentAdapter,
  FulfillmentContext,
  FulfillmentResult,
} from "./adapter";
import { logger } from "@/lib/logger";

/**
 * Build a FulfillmentAdapter for a given ESIMProvider instance.
 * The provider instance is captured in the closure — it is NOT resolved
 * from a global singleton at call time.
 */
export function makeESIMFulfillmentAdapter(
  providerKey: string,
  provider: ESIMProvider,
): FulfillmentAdapter {
  return {
    providerKey,

    async createProviderOrder({ context, supplierProductId }) {
      const result = await provider.createOrder({
        providerPlanId: supplierProductId,
        idempotencyKey: `po_${context.orderId}`,
      });
      return { providerOrderId: result.providerOrderId };
    },

    async provision({ context, providerOrderId }) {
      const result = await provider.provisionESIM({
        providerOrderId,
        idempotencyKey: context.idempotencyKey,
      });

      const fulfillmentResult: FulfillmentResult = {
        externalReference: result.providerESIMId,
        status: "success",
        expiresAt: result.expiresAt,
        metadata: {
          providerESIMId: result.providerESIMId,
          iccid: result.iccid,
          smdpAddress: result.smdpAddress,
          activationCode: result.activationCode,
          matchId: result.matchId,
          dataAmountMB: result.dataAmountMB,
          validityDays: result.validityDays,
          providerOrderId,
        },
      };

      logger.info("fulfillment.esim.provisioned", {
        orderId: context.orderId,
        providerKey,
        providerESIMId: result.providerESIMId,
      });

      return fulfillmentResult;
    },

    async getStatus({ context, providerOrderId, externalReference }) {
      try {
        const esim = await provider.getESIM(externalReference);
        return {
          status: esim.status === "active" ? "success" : "pending",
          metadata: { ...esim, providerOrderId },
        };
      } catch (err) {
        logger.warn("fulfillment.esim.status_unknown", {
          orderId: context.orderId,
          providerOrderId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { status: "unknown", metadata: { providerOrderId } };
      }
    },

    async cancel({ context, externalReference }) {
      try {
        await provider.cancel(externalReference);
      } catch (err) {
        logger.warn("fulfillment.esim.cancel_failed", {
          orderId: context.orderId,
          externalReference,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
