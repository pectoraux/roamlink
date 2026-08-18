/**
 * Top-up service — applies a top-up package to an eSIM.
 *
 * Top-up availability comes from the PROVIDER, not assumed. The provider
 * abstraction exposes whether top-up is supported and which packages exist.
 * Idempotent via idempotencyKey on TopUp (unique constraint).
 */

import { db } from "@/lib/db";
import { getESIMProvider } from "@/lib/esim";
import { getPaymentProvider } from "@/lib/payments";
import { mockPaymentProvider } from "@/lib/payments";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/orders/idempotency";
import { runIdempotentOperation, hashPayload } from "@/lib/idempotency/claim";
import { notify } from "@/lib/notifications/service";
import type { Currency } from "@/lib/money";

/** List available top-up packages for an eSIM (from the provider). */
export async function listTopUpPackages(esimId: string, userId: string) {
  const esim = await db.esim.findUnique({ where: { id: esimId } });
  if (!esim || esim.userId !== userId) throw new AppError("not_found", "eSIM not found", 404, "eSIM not found.");
  if (!esim.providerESIMId) return [];
  const provider = getESIMProvider();
  const supported = await provider.supportsTopUp(esim.providerESIMId);
  if (!supported) return [];
  return provider.getTopUpPackages(esim.providerESIMId);
}

/**
 * Purchase + apply a top-up. Idempotent via idempotencyKey.
 * For the mock payment provider, payment is verified server-side then the
 * provider top-up is applied.
 */
export async function purchaseTopUp(input: {
  esimId: string;
  userId: string;
  packageId: string;
  idempotencyKey: string;
  ip?: string;
}): Promise<{ topUpId: string; dataAddedMB: number; newRemainingMB: number }> {
  // Phase 12.3.7: Migrated to the DB-authoritative idempotency primitive.
  // The INSERT into IdempotencyOperation is the atomic claim — no
  // read-then-write window. A concurrent request with the same key loses the
  // INSERT race, polls for completion, and returns the stored result (clean
  // replay) instead of receiving a raw P2002 unique-constraint violation.
  return runIdempotentOperation({
    scope: "purchaseTopUp",
    key: input.idempotencyKey,
    payloadHash: hashPayload({ esimId: input.esimId, packageId: input.packageId }),
    principal: { type: "session", id: input.userId, tenantId: null },
    // Phase 12.3.2.2: providerKey enables reconciliation if the worker crashes
    // after the topup is applied but before COMPLETED is stored.
    providerKey: input.idempotencyKey,
    execute: async (providerKey) => {
      // Domain-level replay: if the TopUp row already exists, return it.
      const existing = await db.topUp.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        const esim = await db.esim.findUnique({ where: { id: input.esimId } });
        return { topUpId: existing.id, dataAddedMB: existing.dataAmount, newRemainingMB: esim?.dataRemaining ?? 0 };
      }

      const esim = await db.esim.findUnique({ where: { id: input.esimId } });
      if (!esim || esim.userId !== input.userId) throw new AppError("not_found", "eSIM not found", 404, "eSIM not found.");
      if (!esim.providerESIMId) throw new AppError("conflict", "eSIM not provisioned", 409, "This eSIM is not provisioned yet.");

      const esimProvider = getESIMProvider();
      const supported = await esimProvider.supportsTopUp(esim.providerESIMId);
      if (!supported) throw new AppError("conflict", "Top-up not supported", 409, "Top-ups are not supported for this eSIM.");

      const packages = await esimProvider.getTopUpPackages(esim.providerESIMId);
      const pkg = packages.find((p) => p.id === input.packageId);
      if (!pkg) throw new AppError("not_found", "Top-up package not found", 404, "This top-up package is no longer available.");

      // --- Payment (server-side verified) ---
      const paymentProvider = getPaymentProvider();
      const intent = await paymentProvider.createPaymentIntent({
        amountMinor: pkg.priceMinor,
        currency: pkg.currency as Currency,
        description: `Top-up ${pkg.name}`,
        // Phase 12.3.2.2: use the providerKey (same as the operation key) so
        // reconciliation can query the payment provider with this key.
        idempotencyKey: `tu_pay_${providerKey}`,
        metadata: { esimId: input.esimId, packageId: input.packageId },
      });

      // For mock: confirm immediately, then verify.
      if (paymentProvider.isMock) {
        mockPaymentProvider.confirmIntent(intent.providerReference);
      }
      const verification = await paymentProvider.verifyPayment({
        providerReference: intent.providerReference,
        idempotencyKey: `tu_verify_${providerKey}`,
      });
      if (verification.status !== "succeeded") {
        throw new AppError("payment", "Top-up payment failed", 402, "We couldn't process your top-up payment. Please try again.");
      }

      // --- Apply top-up via provider (idempotent) ---
      const result = await esimProvider.topUp({
        providerESIMId: esim.providerESIMId,
        packageId: pkg.id,
        // Phase 12.3.2.2: use the same providerKey for the eSIM provider's topup
        // call so reconciliation can query it.
        idempotencyKey: providerKey,
      });

      // Record top-up + update eSIM.
      const [topUp] = await db.$transaction([
        db.topUp.create({
          data: {
            esimId: input.esimId,
            userId: input.userId,
            amount: pkg.priceMinor,
            currency: pkg.currency,
            dataAmount: pkg.dataAmountMB,
            paymentStatus: "succeeded",
            providerReference: result.providerReference,
            idempotencyKey: input.idempotencyKey,
          },
        }),
        db.esim.update({
          where: { id: input.esimId },
          data: { dataRemaining: { increment: pkg.dataAmountMB }, status: "active" },
        }),
        db.usage.create({
          data: { esimId: input.esimId, dataUsed: 0, dataRemaining: result.newRemainingMB, source: "provider" },
        }),
      ]);

      await audit({ userId: input.userId, action: "topup.purchased", entity: "esim", entityId: input.esimId, ip: input.ip });
      await notify.topUpSuccessful(input.userId, input.esimId, pkg.dataAmountMB);
      logger.info("topup.applied", { esimId: input.esimId, packageId: pkg.id, added: pkg.dataAmountMB });
      return { topUpId: topUp.id, dataAddedMB: pkg.dataAmountMB, newRemainingMB: result.newRemainingMB };
    },
  });
}
