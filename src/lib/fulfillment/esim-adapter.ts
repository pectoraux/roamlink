/**
 * ESIM Fulfillment Adapter — wraps the existing ESIMProvider abstraction so
 * the orchestrator can fulfill ESIM orders without knowing about eSIM-specific
 * APIs (SM-DP+, ICCID, activation codes).
 *
 * The adapter is registered under the providerKey (e.g. "mock") and resolves
 * to the corresponding ESIMProvider via the existing factory.
 */

import type { ESIMProvider } from "@/lib/esim";
import { getESIMProvider } from "@/lib/esim";
import type {
  FulfillmentAdapter,
  FulfillmentContext,
  FulfillmentResult,
} from "./adapter";
import { logger } from "@/lib/logger";

/**
 * Build a FulfillmentAdapter for a given ESIMProvider instance. Used by the
 * registry to register one adapter per providerKey.
 */
export function makeESIMFulfillmentAdapter(
  providerKey: string,
  provider: ESIMProvider = getESIMProvider(),
): FulfillmentAdapter {
  return {
    providerKey,

    async createProviderOrder({ context, providerPlanId }) {
      const result = await provider.createOrder({
        providerPlanId,
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

/**
 * The default ESIM fulfillment adapter — registered under the currently
 * active ESIMProvider's id (default: "mock").
 */
export const ESIMFulfillmentAdapter: FulfillmentAdapter = makeESIMFulfillmentAdapter(
  getESIMProvider().id,
);
