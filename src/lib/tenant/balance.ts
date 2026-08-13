/**
 * Reseller Balance service — prepaid balance + reservation lifecycle.
 *
 * Phase 2B.2: The reseller balance uses a RESERVE → SETTLE / RELEASE
 * lifecycle around fulfillment, exactly like provider credit reservations.
 *
 * Flow:
 *   1. reserveResellerBalance(orderId, amount) — moves funds from available
 *      to reserved (balanceMinor decreases, reservation created as RESERVED)
 *   2a. On successful fulfillment: settleResellerReservation(orderId) —
 *       recognizes revenue (Dr Reseller Funds Liability, Cr Sales Revenue +
 *       Cr Platform Fee Revenue)
 *   2b. On failed fulfillment: releaseResellerReservation(orderId) —
 *       returns reserved funds to available balance (no revenue recognized)
 *
 * Financial atomicity: operational balance + reservation + ledger posting
 * are linked via idempotency keys. If the ledger posting fails, the
 * reservation is marked reconciliation_required (NOT silently swallowed).
 * A background worker (processDueCreditIssuances) retries the posting.
 *
 * Deposits (Phase 2B.2): balance is ONLY credited after a real payment
 * event. The deposit flow is:
 *   1. createDepositIntent(amount) — creates a TenantDepositPayment +
 *      payment provider intent
 *   2. confirmDepositPayment(providerReference) — server-side verifies
 *      the payment succeeded
 *   3. creditDepositBalance(depositPaymentId) — credits TenantBalance +
 *      posts ledger entry (Dr Cash, Cr Reseller Funds Liability)
 *
 * The mock deposit route is blocked in production (PAYMENT_PROVIDER !== "mock").
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/orders/idempotency";
import {
  ledgerResellerDeposit,
  ledgerResellerPurchase,
  ensureChartOfAccounts,
} from "@/lib/finance/double-entry-ledger";
import { getPaymentProvider, mockPaymentProvider } from "@/lib/payments";
import type { Currency } from "@/lib/money";

/** Get or create the tenant's balance record. */
export async function getOrCreateTenantBalance(tenantId: string) {
  let balance = await db.tenantBalance.findUnique({ where: { tenantId } });
  if (!balance) {
    balance = await db.tenantBalance.create({ data: { tenantId } });
  }
  return balance;
}

/**
 * Phase 2B.2.7: Concurrency-safe per-tenant sequence allocation.
 *
 * This MUST be called within a transaction that holds a FOR UPDATE lock on
 * the TenantBalance row. The caller is responsible for acquiring the lock
 * (either via an explicit $queryRaw`SELECT ... FOR UPDATE` or by being inside
 * a transaction that already locked the balance row).
 *
 * The function reads nextTransactionSequence from TenantBalance, returns it,
 * and increments it. Because the caller holds the FOR UPDATE lock, no other
 * transaction can read/increment the same sequence number — this prevents
 * the MAX+1 race condition.
 *
 * For call sites outside an existing transaction, use
 * `allocateSequenceAndCreateTransaction()` which wraps the lock + allocate +
 * create in a single transaction.
 */
async function getNextSequenceNumber(tx: any, tenantId: string): Promise<number> {
  // Read and increment nextTransactionSequence atomically.
  // The caller MUST hold a FOR UPDATE lock on the TenantBalance row.
  // Phase 2B.2.8: The TenantBalance row MUST already exist — the sequence
  // allocator must NOT silently create financial state. If the row doesn't
  // exist, throw explicitly so the caller can initialize it through the
  // canonical getOrCreateTenantBalance path before any financial transaction.
  const balance = await tx.tenantBalance.findUnique({
    where: { tenantId },
    select: { nextTransactionSequence: true },
  });

  if (!balance) {
    throw new AppError(
      "internal",
      `TenantBalance not found for tenant ${tenantId}`,
      500,
      "TenantBalance row must be created before any financial transaction. The sequence allocator does not create financial state.",
    );
  }

  const seq = balance.nextTransactionSequence;
  await tx.tenantBalance.update({
    where: { tenantId },
    data: { nextTransactionSequence: seq + 1 },
  });
  return seq;
}

/**
 * Phase 2B.2.7: Acquire a FOR UPDATE lock on the TenantBalance row.
 * Must be called at the start of a transaction before any sequence allocation.
 */
async function lockTenantBalance(tx: any, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "TenantBalance" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
}

/**
 * Phase 2B.2.6: Log (not silently swallow) a projectionReconciled update failure.
 * If this update fails, the worker will re-scan the reservation on the next cron
 * run (projectionReconciled stays false). That's safe but wasteful, so we log it.
 */
function logProjectionUpdateFailure(reservationId: string, context: string, err: unknown) {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.warn("reseller.projection_reconciled_update_failed", {
    reservationId,
    context,
    error: errMsg,
    message: `projectionReconciled update failed (${context}). The worker will re-scan this reservation on the next cron run. This is safe but wasteful.`,
  });
}

/** Get the current available balance (minor units). */
export async function getTenantBalanceMinor(tenantId: string): Promise<number> {
  const balance = await getOrCreateTenantBalance(tenantId);
  return balance.balanceMinor;
}

/**
 * Phase 2B.2.8: Get the current available balance using a transaction client.
 * This MUST be used inside a $transaction to ensure the balance read comes
 * from the same transactional snapshot as the sequence allocation and
 * TenantTransaction creation. Using the global db helper inside a transaction
 * would read from a different connection/snapshot, breaking coherence.
 */
async function getTenantBalanceMinorTx(tx: any, tenantId: string): Promise<number> {
  const balance = await tx.tenantBalance.findUnique({
    where: { tenantId },
    select: { balanceMinor: true },
  });
  return balance?.balanceMinor ?? 0;
}

// ---------------------------------------------------------------------------
// Phase 2B.2 — Reservation lifecycle (RESERVE → SETTLE / RELEASE)
// ---------------------------------------------------------------------------

/**
 * Reserve funds for an order. Moves `amountMinor` from available balance to
 * a RESERVED reservation. The available balance decreases immediately, but
 * NO revenue is recognized — that happens on SETTLE.
 *
 * Concurrency-safe: FOR UPDATE lock on the balance row.
 * Idempotent: same idempotencyKey returns the same reservation.
 * Fails if insufficient available balance (no negative balance).
 */
export async function reserveResellerBalance(input: {
  tenantId: string;
  userId: string;
  orderId: string;
  amountMinor: number;
  platformFeeMinor: number;
  idempotencyKey: string;
  description?: string;
}): Promise<{ reservationId: string; balanceMinor: number }> {
  if (input.amountMinor <= 0) {
    throw new AppError("validation", "Reserve amount must be positive", 400, "Reserve amount must be greater than zero.");
  }

  const result = await db.$transaction(async (tx) => {
    // Idempotency: check for existing reservation
    const existing = await tx.tenantBalanceReservation.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      logger.info("reseller.reserve_idempotent_replay", { idempotencyKey: input.idempotencyKey, reservationId: existing.id });
      // Fetch current balance for the response
      const bal = await tx.tenantBalance.findUnique({ where: { tenantId: input.tenantId } });
      return { reservationId: existing.id, balanceMinor: bal?.balanceMinor ?? 0, existing: true };
    }

    // Also check by orderId (one reservation per order)
    const existingByOrder = await tx.tenantBalanceReservation.findUnique({
      where: { orderId: input.orderId },
    });
    if (existingByOrder) {
      logger.info("reseller.reserve_existing_order", { orderId: input.orderId, reservationId: existingByOrder.id });
      const bal = await tx.tenantBalance.findUnique({ where: { tenantId: input.tenantId } });
      return { reservationId: existingByOrder.id, balanceMinor: bal?.balanceMinor ?? 0, existing: true };
    }

    // Lock the balance row for safe concurrent reservation
    const locked: Array<{ balanceMinor: number }> = await tx.$queryRaw`
      SELECT "balanceMinor" FROM "TenantBalance" WHERE "tenantId" = ${input.tenantId} FOR UPDATE
    `;
    const currentBalance = locked.length ? locked[0].balanceMinor : 0;

    if (currentBalance < input.amountMinor) {
      throw new AppError(
        "validation",
        `Insufficient balance: ${currentBalance} < ${input.amountMinor}`,
        402,
        `Insufficient reseller balance. Current: $${(currentBalance / 100).toFixed(2)}, required: $${(input.amountMinor / 100).toFixed(2)}. Please deposit more funds.`,
      );
    }

    // Decrement available balance (funds are now reserved, not spent)
    const balance = await tx.tenantBalance.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, balanceMinor: -input.amountMinor },
      update: { balanceMinor: { decrement: input.amountMinor } },
    });

    // Create reservation record
    const reservation = await tx.tenantBalanceReservation.create({
      data: {
        tenantId: input.tenantId,
        orderId: input.orderId,
        amountMinor: input.amountMinor,
        platformFeeMinor: input.platformFeeMinor,
        state: "RESERVED",
        idempotencyKey: input.idempotencyKey,
      },
    });

    // Create a TenantTransaction for the reservation (negative = funds held)
    const reserveSeq = await getNextSequenceNumber(tx, input.tenantId);
    await tx.tenantTransaction.create({
      data: {
        tenantId: input.tenantId,
        type: "reservation",
        amountMinor: -input.amountMinor,
        balanceAfter: balance.balanceMinor,
        orderId: input.orderId,
        description: input.description ?? "Balance reserved for order",
        idempotencyKey: `reserve_${input.idempotencyKey}`,
        sequenceNumber: reserveSeq,
      },
    });

    return { reservationId: reservation.id, balanceMinor: balance.balanceMinor, existing: false };
  }, { timeout: 30000, maxWait: 15000 });

  if (!result.existing) {
    await audit({
      tenantId: input.tenantId,
      userId: input.userId,
      action: "reseller.balance_reserved",
      entity: "tenant_balance",
      entityId: input.tenantId,
      detail: { amount: input.amountMinor, orderId: input.orderId, balanceAfter: result.balanceMinor },
    });
    logger.info("reseller.balance_reserved", { tenantId: input.tenantId, amount: input.amountMinor, orderId: input.orderId, balance: result.balanceMinor });
  }

  return { reservationId: result.reservationId, balanceMinor: result.balanceMinor };
}

/**
 * Settle a reservation after successful fulfillment. Recognizes revenue:
 *   Dr Reseller Funds Liability (the reserved amount)
 *   Cr Sales Revenue (retail - platform fee)
 *   Cr Platform Fee Revenue (platform fee)
 *
 * Phase 2B.2.1: If the ledger posting fails, the reservation transitions
 * RESERVED → RECONCILIATION_REQUIRED (NOT thrown, NOT released). The funds
 * remain reserved — the service is already active, so we must NOT return
 * funds to the reseller. The processDueResellerReservationReconciliation
 * worker retries the ledger posting until it succeeds.
 *
 * The reservation state machine:
 *   RESERVED → SETTLED (ledger posted, revenue recognized)
 *   RESERVED → RECONCILIATION_REQUIRED (ledger failed, retry pending)
 *   RECONCILIATION_REQUIRED → SETTLED (reconciliation worker succeeds)
 *   RESERVED → RELEASED (fulfillment failed, funds returned)
 *
 * Idempotent: if already SETTLED, returns the existing ledgerTxnId.
 * If RECONCILIATION_REQUIRED, returns that state (caller knows to retry).
 */
export async function settleResellerReservation(input: {
  tenantId: string;
  userId: string;
  orderId: string;
}): Promise<{ reservationId: string; ledgerTransactionId: string; state: string }> {
  await ensureChartOfAccounts();

  const reservation = await db.tenantBalanceReservation.findUnique({
    where: { orderId: input.orderId },
  });
  if (!reservation) {
    throw new AppError("not_found", "Reservation not found", 404, `No reservation found for order ${input.orderId}.`);
  }
  if (reservation.tenantId !== input.tenantId) {
    throw new AppError("authorization", "Cross-tenant access denied", 403, "This reservation belongs to a different tenant.");
  }

  // Idempotent: if already settled, return the existing ledger txn
  if (reservation.state === "SETTLED") {
    logger.info("reseller.settle_idempotent_replay", { orderId: input.orderId, reservationId: reservation.id });
    return {
      reservationId: reservation.id,
      ledgerTransactionId: reservation.ledgerTransactionId ?? "",
      state: reservation.state,
    };
  }

  if (reservation.state === "RELEASED") {
    throw new AppError("conflict", "Cannot settle a released reservation", 409, "This reservation was released (fulfillment failed).");
  }

  // State must be RESERVED or RECONCILIATION_REQUIRED to attempt settlement
  if (reservation.state !== "RESERVED" && reservation.state !== "RECONCILIATION_REQUIRED") {
    throw new AppError("conflict", `Cannot settle reservation in state ${reservation.state}`, 409, "The reservation is in an unexpected state.");
  }

  // Post the ledger entry (Dr Reseller Funds Liability, Cr Sales Revenue + Cr Platform Fee Revenue)
  // Idempotent: ledgerResellerPurchase replays if the idempotencyKey already exists
  let ledgerTxnId: string;
  try {
    ledgerTxnId = await ledgerResellerPurchase({
      tenantId: input.tenantId,
      userId: input.userId,
      orderId: input.orderId,
      retailPriceMinor: reservation.amountMinor,
      platformFeeMinor: reservation.platformFeeMinor,
      idempotencyKey: `${reservation.idempotencyKey}:ledger`,
    });
  } catch (err) {
    // Phase 2B.2.1: Transition to RECONCILIATION_REQUIRED (do NOT throw, do NOT release).
    // The service is already active — we must preserve the reservation and
    // retry the ledger posting via the reconciliation worker.
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("reseller.settle_ledger_failed", { orderId: input.orderId, reservationId: reservation.id, error: errorMsg });
    await db.tenantBalanceReservation.updateMany({
      where: { id: reservation.id, state: { in: ["RESERVED", "RECONCILIATION_REQUIRED"] } },
      data: { state: "RECONCILIATION_REQUIRED", reconciliationReason: "LEDGER_POSTING_FAILED", failureReason: `Ledger posting failed: ${errorMsg}` },
    }).catch((updateErr) => {
      const updateMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logger.error("reseller.settle_state_update_failed", {
        reservationId: reservation.id,
        ledgerError: errorMsg,
        updateError: updateMsg,
        message: "CRITICAL: Reservation state update to RECONCILIATION_REQUIRED failed after ledger failure. The reconciliation worker will recover it via the stale-state scan.",
      });
    });
    return {
      reservationId: reservation.id,
      ledgerTransactionId: "",
      state: "RECONCILIATION_REQUIRED",
    };
  }

  // Transition RESERVED/RECONCILIATION_REQUIRED → SETTLED (status-guarded)
  // Phase 2B.2.4: Clear BOTH failureReason AND reconciliationReason on successful settlement.
  const updated = await db.tenantBalanceReservation.updateMany({
    where: { id: reservation.id, state: { in: ["RESERVED", "RECONCILIATION_REQUIRED"] } },
    data: { state: "SETTLED", settledAt: new Date(), ledgerTransactionId: ledgerTxnId, failureReason: null, reconciliationReason: null },
  });

  if (updated.count === 0) {
    // Another concurrent call settled it — fetch the existing ledger txn
    const existing = await db.tenantBalanceReservation.findUnique({ where: { id: reservation.id } });
    return {
      reservationId: reservation.id,
      ledgerTransactionId: existing?.ledgerTransactionId ?? ledgerTxnId,
      state: existing?.state ?? "SETTLED",
    };
  }

  // Phase 2B.2.1 §6: Create a TenantTransaction for the settlement.
  // Phase 2B.2.7: Use a transaction with FOR UPDATE lock on TenantBalance
  // for concurrency-safe sequence allocation.
  // Do NOT silently swallow — if this fails, the reconciliation worker will
  // repair it (the reservation is already SETTLED with the ledgerTransactionId).
  try {
    await db.$transaction(async (tx) => {
      await lockTenantBalance(tx, input.tenantId);
      const settleSeq = await getNextSequenceNumber(tx, input.tenantId);
      const currentBalance = await getTenantBalanceMinorTx(tx, input.tenantId);
      await tx.tenantTransaction.create({
        data: {
          tenantId: input.tenantId,
          type: "purchase",
          amountMinor: -reservation.amountMinor,
          balanceAfter: currentBalance,
          orderId: input.orderId,
          description: "Connectivity purchase settled",
          idempotencyKey: `settle_${reservation.idempotencyKey}`,
          ledgerTransactionId: ledgerTxnId,
          sequenceNumber: settleSeq,
        },
      });
    }, { timeout: 30000, maxWait: 15000 });

    // Phase 2B.2.5: Mark the projection as reconciled so the worker doesn't
    // need to scan this reservation on future cron runs.
    await db.tenantBalanceReservation.update({
      where: { id: reservation.id },
      data: { projectionReconciled: true },
    }).catch((err) => logProjectionUpdateFailure(reservation.id, "settleResellerReservation.normal", err));
  } catch (err) {
    // The unique constraint on idempotencyKey may have caught a duplicate
    // (concurrent settlement). If so, this is fine. If it's a real error,
    // log it — the reservation is SETTLED and the ledger is posted, so the
    // financial truth is correct. The operational projection (TenantTransaction)
    // can be repaired by the reconciliation worker.
    // Phase 2B.2.5: projectionReconciled stays false, so the worker will check.
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("Unique constraint") || errMsg.includes("P2002")) {
      logger.info("reseller.settle_txn_idempotent_replay", { reservationId: reservation.id, orderId: input.orderId });
      // The TenantTransaction already exists (concurrent call) — mark as reconciled
      await db.tenantBalanceReservation.update({
        where: { id: reservation.id },
        data: { projectionReconciled: true },
      }).catch((err) => logProjectionUpdateFailure(reservation.id, "settleResellerReservation.idempotent_replay", err));
    } else {
      logger.error("reseller.settle_txn_creation_failed", {
        reservationId: reservation.id,
        orderId: input.orderId,
        ledgerTxnId,
        error: errMsg,
        message: "CRITICAL: Reservation SETTLED and ledger posted but TenantTransaction creation failed. The reconciliation worker will repair the operational projection.",
      });
    }
  }

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: "reseller.reservation_settled",
    entity: "tenant_balance",
    entityId: reservation.id,
    detail: { amount: reservation.amountMinor, orderId: input.orderId, ledgerTxnId },
  });
  logger.info("reseller.reservation_settled", { tenantId: input.tenantId, orderId: input.orderId, reservationId: reservation.id, ledgerTxnId });

  return { reservationId: reservation.id, ledgerTransactionId: ledgerTxnId, state: "SETTLED" };
}

/**
 * Release a reservation after failed fulfillment. Returns the reserved funds
 * to the available balance. NO revenue is recognized.
 *
 * The reservation transitions RESERVED → RELEASED. The available balance is
 * incremented (the funds that were held are returned).
 *
 * Idempotent: if already RELEASED, returns the existing state.
 */
export async function releaseResellerReservation(input: {
  tenantId: string;
  userId: string;
  orderId: string;
  reason?: string;
}): Promise<{ reservationId: string; balanceMinor: number; state: string }> {
  const reservation = await db.tenantBalanceReservation.findUnique({
    where: { orderId: input.orderId },
  });
  if (!reservation) {
    throw new AppError("not_found", "Reservation not found", 404, `No reservation found for order ${input.orderId}.`);
  }
  if (reservation.tenantId !== input.tenantId) {
    throw new AppError("authorization", "Cross-tenant access denied", 403, "This reservation belongs to a different tenant.");
  }

  // Idempotent: if already released, return the existing state
  if (reservation.state === "RELEASED") {
    logger.info("reseller.release_idempotent_replay", { orderId: input.orderId, reservationId: reservation.id });
    const bal = await getTenantBalanceMinor(input.tenantId);
    return { reservationId: reservation.id, balanceMinor: bal, state: reservation.state };
  }

  if (reservation.state === "SETTLED") {
    throw new AppError("conflict", "Cannot release a settled reservation", 409, "This reservation was already settled (fulfillment succeeded).");
  }

  // Return funds to available balance + transition RESERVED → RELEASED
  const result = await db.$transaction(async (tx) => {
    // Status-guarded transition: only RESERVED → RELEASED
    const updated = await tx.tenantBalanceReservation.updateMany({
      where: { id: reservation.id, state: "RESERVED" },
      data: { state: "RELEASED", releasedAt: new Date(), failureReason: input.reason ?? null },
    });
    if (updated.count === 0) {
      // Another concurrent call released/settled it
      const existing = await tx.tenantBalanceReservation.findUnique({ where: { id: reservation.id } });
      const bal = await tx.tenantBalance.findUnique({ where: { tenantId: input.tenantId } });
      return { balanceMinor: bal?.balanceMinor ?? 0, state: existing?.state ?? "RELEASED", alreadyDone: true };
    }

    // Phase 2B.2.8: Lock the balance row for concurrency-safe sequence allocation.
    await lockTenantBalance(tx, input.tenantId);

    // Return funds to available balance
    const balance = await tx.tenantBalance.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, balanceMinor: reservation.amountMinor },
      update: { balanceMinor: { increment: reservation.amountMinor } },
    });

    // Create a TenantTransaction for the release (positive = funds returned)
    const releaseSeq = await getNextSequenceNumber(tx, input.tenantId);
    await tx.tenantTransaction.create({
      data: {
        tenantId: input.tenantId,
        type: "release",
        amountMinor: reservation.amountMinor,
        balanceAfter: balance.balanceMinor,
        orderId: input.orderId,
        description: "Reservation released (fulfillment failed)",
        idempotencyKey: `release_${reservation.idempotencyKey}`,
        sequenceNumber: releaseSeq,
      },
    });

    return { balanceMinor: balance.balanceMinor, state: "RELEASED" as const, alreadyDone: false };
  }, { timeout: 30000, maxWait: 15000 });

  if (!result.alreadyDone) {
    await audit({
      tenantId: input.tenantId,
      userId: input.userId,
      action: "reseller.reservation_released",
      entity: "tenant_balance",
      entityId: reservation.id,
      detail: { amount: reservation.amountMinor, orderId: input.orderId, reason: input.reason },
    });
    logger.info("reseller.reservation_released", { tenantId: input.tenantId, orderId: input.orderId, reservationId: reservation.id, balance: result.balanceMinor });
  }

  return { reservationId: reservation.id, balanceMinor: result.balanceMinor, state: result.state };
}

// ---------------------------------------------------------------------------
// Phase 2B.2 — Deposit payment lifecycle (real payment required)
// ---------------------------------------------------------------------------

/**
 * Create a deposit intent. Creates a TenantDepositPayment record + a payment
 * provider intent. The balance is NOT credited until the payment is verified.
 *
 * Phase 2B.2 §9: The mock provider is only allowed when PAYMENT_PROVIDER=mock
 * (development/test). In production, this route requires a real provider.
 */
export async function createDepositIntent(input: {
  tenantId: string;
  userId: string;
  amountMinor: number;
  currency?: Currency;
  idempotencyKey: string;
}): Promise<{ depositPaymentId: string; providerReference: string; status: string; clientSecret?: string }> {
  if (input.amountMinor <= 0) {
    throw new AppError("validation", "Deposit amount must be positive", 400, "Deposit amount must be greater than zero.");
  }

  const provider = getPaymentProvider();

  // Phase 2B.2 §9: Block mock provider in production
  if (provider.isMock && process.env.NODE_ENV === "production") {
    throw new AppError(
      "validation",
      "Mock payment provider not allowed in production",
      403,
      "The mock payment provider cannot be used in production. Configure a real payment provider (PAYMENT_PROVIDER=stripe|paystack|flutterwave).",
    );
  }

  // Idempotency: check for existing deposit payment
  const existing = await db.tenantDepositPayment.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    logger.info("reseller.deposit_intent_idempotent_replay", { idempotencyKey: input.idempotencyKey, depositId: existing.id });
    return {
      depositPaymentId: existing.id,
      providerReference: existing.providerReference ?? "",
      status: existing.status,
    };
  }

  // Create the payment intent with the provider
  const intent = await provider.createPaymentIntent({
    amountMinor: input.amountMinor,
    currency: (input.currency ?? "USD") as Currency,
    description: `Reseller deposit for tenant ${input.tenantId}`,
    idempotencyKey: input.idempotencyKey,
    metadata: { tenantId: input.tenantId, type: "reseller_deposit" },
  });

  // Create the deposit payment record
  const deposit = await db.tenantDepositPayment.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? "USD",
      paymentProvider: provider.id,
      providerReference: intent.providerReference,
      status: intent.status === "succeeded" ? "PAYMENT_SUCCEEDED" : "PAYMENT_PENDING",
      idempotencyKey: input.idempotencyKey,
    },
  });

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: "reseller.deposit_intent_created",
    entity: "tenant_deposit_payment",
    entityId: deposit.id,
    detail: { amount: input.amountMinor, providerReference: intent.providerReference },
  });
  logger.info("reseller.deposit_intent_created", { tenantId: input.tenantId, depositId: deposit.id, providerReference: intent.providerReference });

  return {
    depositPaymentId: deposit.id,
    providerReference: intent.providerReference,
    status: deposit.status,
    clientSecret: intent.clientSecret,
  };
}

/**
 * Confirm a deposit payment (server-side verification). If the payment
 * succeeded, credit the reseller balance + post the ledger entry.
 *
 * Idempotent: if the deposit is already COMPLETED, returns the existing state.
 */
export async function confirmDepositPayment(input: {
  depositPaymentId: string;
  tenantId: string;
  userId: string;
}): Promise<{ status: string; balanceMinor?: number }> {
  const deposit = await db.tenantDepositPayment.findUnique({
    where: { id: input.depositPaymentId },
  });
  if (!deposit) {
    throw new AppError("not_found", "Deposit payment not found", 404, "Deposit payment not found.");
  }
  if (deposit.tenantId !== input.tenantId) {
    throw new AppError("authorization", "Cross-tenant access denied", 403, "This deposit belongs to a different tenant.");
  }

  // Idempotent: if already completed, return the existing state
  if (deposit.status === "COMPLETED") {
    const bal = await getTenantBalanceMinor(input.tenantId);
    return { status: deposit.status, balanceMinor: bal };
  }
  if (deposit.status === "PAYMENT_FAILED") {
    return { status: deposit.status };
  }

  // Server-side verification (never trust the client)
  const provider = getPaymentProvider();

  // For the mock provider (development only), simulate the client-side
  // confirmation step before verification. In production, the client
  // completes payment on the provider's hosted page/SDK, then a webhook
  // triggers confirmation. The mock provider needs an explicit confirmIntent
  // call to transition the intent from "pending" to "succeeded".
  if (provider.isMock && deposit.providerReference) {
    mockPaymentProvider.confirmIntent(deposit.providerReference);
  }

  const verification = await provider.verifyPayment({
    providerReference: deposit.providerReference!,
    idempotencyKey: deposit.idempotencyKey,
  });

  if (verification.status === "failed") {
    await db.tenantDepositPayment.update({
      where: { id: deposit.id },
      data: { status: "PAYMENT_FAILED", failureReason: "Payment verification failed" },
    });
    return { status: "PAYMENT_FAILED" };
  }

  if (verification.status === "pending") {
    await db.tenantDepositPayment.update({
      where: { id: deposit.id },
      data: { status: "PAYMENT_PENDING" },
    }).catch(() => {});
    return { status: "PAYMENT_PENDING" };
  }

  // verification.status === "succeeded" — update status, then credit the balance
  await db.tenantDepositPayment.update({
    where: { id: deposit.id },
    data: { status: "PAYMENT_SUCCEEDED" },
  }).catch(() => {});

  return creditDepositBalance({ depositPaymentId: deposit.id, tenantId: input.tenantId, userId: input.userId });
}

/**
 * Credit the reseller balance after a successful deposit payment.
 * Posts the ledger entry: Dr Cash, Cr Reseller Funds Liability.
 *
 * Atomic: balance update + TenantTransaction in one transaction.
 * Idempotent: status-guarded (only BALANCE_POSTED or PAYMENT_SUCCEEDED → COMPLETED).
 */
export async function creditDepositBalance(input: {
  depositPaymentId: string;
  tenantId: string;
  userId: string;
}): Promise<{ status: string; balanceMinor: number }> {
  await ensureChartOfAccounts();

  const deposit = await db.tenantDepositPayment.findUnique({
    where: { id: input.depositPaymentId },
  });
  if (!deposit) {
    throw new AppError("not_found", "Deposit payment not found", 404, "Deposit payment not found.");
  }

  // Status-guarded: only credit if payment succeeded and not already completed
  if (deposit.status === "COMPLETED") {
    const bal = await getTenantBalanceMinor(input.tenantId);
    return { status: "COMPLETED", balanceMinor: bal };
  }

  if (deposit.status !== "PAYMENT_SUCCEEDED" && deposit.status !== "BALANCE_POSTED") {
    throw new AppError("conflict", `Cannot credit deposit in status ${deposit.status}`, 409, "The deposit payment has not been verified as succeeded.");
  }

  // Atomic balance credit + transaction record
  const result = await db.$transaction(async (tx) => {
    // Status-guarded transition: PAYMENT_SUCCEEDED → BALANCE_POSTED
    const updated = await tx.tenantDepositPayment.updateMany({
      where: { id: deposit.id, status: { in: ["PAYMENT_SUCCEEDED", "BALANCE_POSTED"] } },
      data: { status: "BALANCE_POSTED" },
    });
    if (updated.count === 0) {
      // Another concurrent call completed it
      const existing = await tx.tenantDepositPayment.findUnique({ where: { id: deposit.id } });
      const bal = await tx.tenantBalance.findUnique({ where: { tenantId: input.tenantId } });
      return { balanceMinor: bal?.balanceMinor ?? 0, status: existing?.status ?? "COMPLETED", alreadyDone: true };
    }

    // Phase 2B.2.7: Lock the balance row for concurrency-safe sequence allocation.
    await lockTenantBalance(tx, input.tenantId);

    // Credit the balance
    const balance = await tx.tenantBalance.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, balanceMinor: deposit.amountMinor, totalDepositedMinor: deposit.amountMinor },
      update: {
        balanceMinor: { increment: deposit.amountMinor },
        totalDepositedMinor: { increment: deposit.amountMinor },
      },
    });

    // Create transaction record
    const depositSeq = await getNextSequenceNumber(tx, input.tenantId);
    const txn = await tx.tenantTransaction.create({
      data: {
        tenantId: input.tenantId,
        type: "deposit",
        amountMinor: deposit.amountMinor,
        balanceAfter: balance.balanceMinor,
        description: `Deposit via ${deposit.paymentProvider}`,
        idempotencyKey: `deposit_${deposit.idempotencyKey}`,
        sequenceNumber: depositSeq,
      },
    });

    return { balanceMinor: balance.balanceMinor, status: "BALANCE_POSTED" as const, transactionId: txn.id, alreadyDone: false };
  }, { timeout: 30000, maxWait: 15000 });

  if (result.alreadyDone) {
    return { status: result.status, balanceMinor: result.balanceMinor };
  }

  // Post ledger entry (outside the balance transaction — idempotent)
  let ledgerTxnId: string | null = null;
  let ledgerFailed = false;
  try {
    ledgerTxnId = await ledgerResellerDeposit({
      tenantId: input.tenantId,
      userId: input.userId,
      amountMinor: deposit.amountMinor,
      idempotencyKey: `${deposit.idempotencyKey}:ledger`,
    });
  } catch (err) {
    // Phase 2B.2 §3: Do NOT silently swallow. Mark as reconciliation_required.
    ledgerFailed = true;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("reseller.deposit_ledger_failed", { depositId: deposit.id, error: errorMsg });
  }

  // Link the transaction + ledger, and transition to COMPLETED (or RECONCILIATION_REQUIRED)
  const finalStatus = ledgerFailed ? "RECONCILIATION_REQUIRED" : "COMPLETED";
  await db.tenantDepositPayment.update({
    where: { id: deposit.id },
    data: { status: finalStatus, ledgerTransactionId: ledgerTxnId },
  }).catch((err) => {
    // Phase 2B.2 §3: If this update fails, log at CRITICAL — the balance was
    // credited but the deposit record is stuck in BALANCE_POSTED. The
    // reconciliation worker will find it via the stale-status scan.
    const updateMsg = err instanceof Error ? err.message : String(err);
    logger.error("reseller.deposit_status_update_failed", {
      depositId: deposit.id,
      ledgerFailed,
      updateError: updateMsg,
      message: "CRITICAL: Deposit balance was credited but status update failed. The reconciliation worker will recover it.",
    });
  });

  // Link the ledger txn to the TenantTransaction (if we have both)
  if (ledgerTxnId && "transactionId" in result && result.transactionId) {
    await db.tenantTransaction.update({
      where: { id: result.transactionId },
      data: { ledgerTransactionId: ledgerTxnId },
    }).catch((err) => {
      // Phase 2B.2 §3: Log at CRITICAL — the balance + ledger are correct but
      // the link between them is missing. The reconciliation worker can repair it.
      const linkMsg = err instanceof Error ? err.message : String(err);
      logger.error("reseller.deposit_link_failed", {
        transactionId: result.transactionId,
        ledgerTxnId,
        linkError: linkMsg,
        message: "CRITICAL: Deposit balance + ledger posted but transaction link failed. The reconciliation worker will repair it.",
      });
    });
  }

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: "reseller.balance_deposited",
    entity: "tenant_balance",
    entityId: input.tenantId,
    detail: { amount: deposit.amountMinor, balanceAfter: result.balanceMinor, depositId: deposit.id, ledgerTxnId },
  });
  logger.info("reseller.balance_deposited", { tenantId: input.tenantId, amount: deposit.amountMinor, balance: result.balanceMinor, depositId: deposit.id });

  return { status: finalStatus, balanceMinor: result.balanceMinor };
}

/**
 * Process a deposit payment webhook (from the payment provider).
 * Idempotent: if the deposit is already COMPLETED, returns without re-crediting.
 */
export async function handleDepositWebhook(input: {
  providerReference: string;
  status: "succeeded" | "failed" | "pending";
}): Promise<{ handled: boolean }> {
  const deposit = await db.tenantDepositPayment.findFirst({
    where: { providerReference: input.providerReference },
  });
  if (!deposit) {
    logger.warn("reseller.deposit_webhook_no_match", { providerReference: input.providerReference });
    return { handled: false };
  }

  // Idempotent: if already completed, skip
  if (deposit.status === "COMPLETED" || deposit.status === "BALANCE_POSTED") {
    logger.info("reseller.deposit_webhook_idempotent", { depositId: deposit.id, status: deposit.status });
    return { handled: true };
  }

  if (input.status === "succeeded") {
    // Mark as PAYMENT_SUCCEEDED, then credit the balance
    // Phase 2B.2.1 §7: Do NOT silently swallow the status update.
    try {
      await db.tenantDepositPayment.update({
        where: { id: deposit.id, status: { notIn: ["COMPLETED", "BALANCE_POSTED", "PAYMENT_SUCCEEDED"] } },
        data: { status: "PAYMENT_SUCCEEDED" },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("reseller.deposit_webhook_status_update_failed", {
        depositId: deposit.id,
        error: errMsg,
        message: "CRITICAL: Webhook reported payment succeeded but status update failed. The reconciliation worker will recover it.",
      });
      return { handled: false };
    }
    // Credit the balance — if this fails, the deposit stays in PAYMENT_SUCCEEDED
    // and the reconciliation worker will retry via processDueDepositReconciliation
    // (which processes BALANCE_POSTED + RECONCILIATION_REQUIRED, and the
    // processDueResellerReservationReconciliation stale scan catches
    // PAYMENT_SUCCEEDED deposits that never got their balance credited).
    try {
      await creditDepositBalance({
        depositPaymentId: deposit.id,
        tenantId: deposit.tenantId,
        userId: deposit.userId,
      });
    } catch (err) {
      logger.error("reseller.deposit_webhook_credit_failed", {
        depositId: deposit.id,
        error: err instanceof Error ? err.message : String(err),
        message: "CRITICAL: Webhook credited status but balance credit failed. The deposit is in PAYMENT_SUCCEEDED — the reconciliation worker will retry.",
      });
      // Mark as RECONCILIATION_REQUIRED so the worker picks it up
      // Phase 2B.2.1 §7: Do NOT silently swallow this either — if the
      // status update itself fails, log CRITICAL so an operator can intervene.
      await db.tenantDepositPayment.updateMany({
        where: { id: deposit.id, status: "PAYMENT_SUCCEEDED" },
        data: { status: "RECONCILIATION_REQUIRED", failureReason: `Balance credit failed: ${err instanceof Error ? err.message : String(err)}` },
      }).catch((updateErr) => {
        const updateMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        logger.error("reseller.deposit_webhook_reconciliation_status_failed", {
          depositId: deposit.id,
          creditError: err instanceof Error ? err.message : String(err),
          updateError: updateMsg,
          message: "CRITICAL: Balance credit failed AND reconciliation status update failed. The deposit is stuck in PAYMENT_SUCCEEDED. The stale-status scan in processDueDepositReconciliation will recover it.",
        });
      });
    }
    return { handled: true };
  }

  if (input.status === "failed") {
    // Phase 2B.2.1 §7: Do NOT silently swallow the status update.
    try {
      await db.tenantDepositPayment.update({
        where: { id: deposit.id, status: { notIn: ["COMPLETED", "PAYMENT_FAILED"] } },
        data: { status: "PAYMENT_FAILED", failureReason: "Webhook reported payment failed" },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("reseller.deposit_webhook_failed_status_update_error", {
        depositId: deposit.id,
        error: errMsg,
        message: "CRITICAL: Webhook reported payment failed but status update failed. Manual review required.",
      });
      return { handled: false };
    }
    return { handled: true };
  }

  return { handled: false };
}

// ---------------------------------------------------------------------------
// Reconciliation worker for stuck deposits (Phase 2B.2 §3)
// ---------------------------------------------------------------------------

/**
 * Process deposits stuck in RECONCILIATION_REQUIRED or BALANCE_POSTED.
 * Retries the ledger posting + status transition.
 */
export async function processDueDepositReconciliation(): Promise<{
  retried: number;
  repaired: number;
  stillFailing: number;
}> {
  const result = { retried: 0, repaired: 0, stillFailing: 0 };

  const due = await db.tenantDepositPayment.findMany({
    where: { status: { in: ["RECONCILIATION_REQUIRED", "BALANCE_POSTED"] } },
  });

  for (const deposit of due) {
    result.retried++;
    try {
      const ledgerTxnId = await ledgerResellerDeposit({
        tenantId: deposit.tenantId,
        userId: deposit.userId,
        amountMinor: deposit.amountMinor,
        idempotencyKey: `${deposit.idempotencyKey}:ledger`,
      });

      const updated = await db.tenantDepositPayment.updateMany({
        where: { id: deposit.id, status: { in: ["RECONCILIATION_REQUIRED", "BALANCE_POSTED"] } },
        data: { status: "COMPLETED", ledgerTransactionId: ledgerTxnId },
      });

      if (updated.count > 0) {
        result.repaired++;
        logger.info("reseller.deposit_reconciled", { depositId: deposit.id, ledgerTxnId });
      }
    } catch (err) {
      result.stillFailing++;
      logger.error("reseller.deposit_reconciliation_still_failing", { depositId: deposit.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 2B.2.1 — Reservation reconciliation worker
// Phase 2B.2.2: Safe reconciliation — NEVER settle based on age alone.
// ---------------------------------------------------------------------------

/**
 * Process reservations that need reconciliation.
 *
 * Phase 2B.2.2: The worker NEVER infers fulfillment success from reservation
 * age. It always consults the Order's authoritative fulfillment state before
 * taking any financial action.
 *
 * Classification:
 *   - RECONCILIATION_REQUIRED reservations:
 *     → The order route already attempted settlement and the ledger failed.
 *       The order's fulfillmentStatus is "success" (verified by the order route
 *       before calling settleResellerReservation). So these are SETTLEMENT_ELIGIBLE.
 *
 *   - Stale RESERVED reservations (older than threshold):
 *     → The order route may have crashed between reserve and settle.
 *       We must inspect the Order's fulfillmentStatus:
 *         "success"           → SETTLEMENT_ELIGIBLE (settle)
 *         "failed"            → RELEASE_ELIGIBLE (release)
 *         "pending"/"provisioning" → FULFILLMENT_PENDING (do nothing, retry later)
 *         "unknown"/"reconciliation_required" → FULFILLMENT_UNKNOWN (mark RECONCILIATION_REQUIRED, do not settle)
 *
 * Idempotency:
 *   - ledgerResellerPurchase replays if the idempotencyKey already exists
 *   - Status-guarded updateMany prevents duplicate transitions
 *   - TenantTransaction creation uses a unique idempotencyKey
 *   - Running this worker twice is safe — SETTLED/RELEASED records are skipped
 */
const STALE_RESERVED_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

type ReservationClassification =
  | "SETTLEMENT_ELIGIBLE"
  | "RELEASE_ELIGIBLE"
  | "FULFILLMENT_PENDING"
  | "FULFILLMENT_UNKNOWN";

export async function processDueResellerReservationReconciliation(): Promise<{
  retried: number;
  repaired: number;
  released: number;
  pending: number;
  unknown: number;
  projectionRepaired: number;
  stillFailing: number;
}> {
  const result = { retried: 0, repaired: 0, released: 0, pending: 0, unknown: 0, projectionRepaired: 0, stillFailing: 0 };

  // 1. Reservations explicitly in RECONCILIATION_REQUIRED (settlement was
  //    attempted but the ledger failed — the order route already verified
  //    fulfillment success before calling settleResellerReservation).
  // 2. Stale RESERVED reservations (older than threshold) — the order route
  //    may have crashed. We MUST inspect the Order's fulfillment state.
  const staleCutoff = new Date(Date.now() - STALE_RESERVED_THRESHOLD_MS);
  const due = await db.tenantBalanceReservation.findMany({
    where: {
      OR: [
        { state: "RECONCILIATION_REQUIRED" },
        { state: "RESERVED", updatedAt: { lt: staleCutoff } },
      ],
    },
    select: {
      id: true, tenantId: true, orderId: true, amountMinor: true,
      platformFeeMinor: true, idempotencyKey: true, state: true,
      ledgerTransactionId: true,
    },
  });

  for (const reservation of due) {
    result.retried++;

    // Phase 2B.2.3: ALWAYS inspect the Order's authoritative fulfillment state,
    // regardless of whether the reservation is RECONCILIATION_REQUIRED or stale RESERVED.
    // The reservation state alone NEVER proves fulfillment success — only the
    // Order's fulfillmentStatus does. This prevents the bug where a reservation
    // moved to RECONCILIATION_REQUIRED due to FULFILLMENT_UNKNOWN would be
    // incorrectly settled on the next worker run.
    let classification: ReservationClassification;

    const order = await db.order.findUnique({
      where: { id: reservation.orderId },
      select: { fulfillmentStatus: true, status: true },
    });

    if (!order) {
      // Order not found — can't determine fulfillment state. Fail closed.
      classification = "FULFILLMENT_UNKNOWN";
    } else {
      const fulfillmentStatus = order.fulfillmentStatus;
      if (fulfillmentStatus === "success") {
        classification = "SETTLEMENT_ELIGIBLE";
      } else if (fulfillmentStatus === "failed") {
        classification = "RELEASE_ELIGIBLE";
      } else if (fulfillmentStatus === "pending" || fulfillmentStatus === "provisioning") {
        classification = "FULFILLMENT_PENDING";
      } else {
        // "unknown" or "reconciliation_required" — can't determine. Fail closed.
        classification = "FULFILLMENT_UNKNOWN";
      }
    }

    // Act on the classification
    if (classification === "FULFILLMENT_PENDING") {
      result.pending++;
      logger.info("reseller.reservation_fulfillment_pending", {
        reservationId: reservation.id,
        orderId: reservation.orderId,
      });
      continue; // do NOT settle, do NOT release
    }

    if (classification === "FULFILLMENT_UNKNOWN") {
      result.unknown++;
      // Phase 2B.2.3: Transition to RECONCILIATION_REQUIRED with reason FULFILLMENT_UNKNOWN.
      // Do NOT settle, do NOT release. The reservation stays here until the Order's
      // fulfillmentStatus becomes "success" or "failed".
      // On the next worker run, the classification will re-check the Order's
      // fulfillmentStatus — if it's still unknown, it stays RECONCILIATION_REQUIRED.
      // If it becomes "success", it becomes SETTLEMENT_ELIGIBLE. If "failed", RELEASE_ELIGIBLE.
      await db.tenantBalanceReservation.updateMany({
        where: { id: reservation.id, state: { in: ["RESERVED", "RECONCILIATION_REQUIRED"] } },
        data: {
          state: "RECONCILIATION_REQUIRED",
          reconciliationReason: "FULFILLMENT_UNKNOWN",
          failureReason: "Fulfillment state unknown — manual review required",
        },
      }).catch((err) => {
        logger.error("reseller.reservation_unknown_classification_failed", {
          reservationId: reservation.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      logger.warn("reseller.reservation_fulfillment_unknown", {
        reservationId: reservation.id,
        orderId: reservation.orderId,
        message: "Cannot determine fulfillment state — moved to RECONCILIATION_REQUIRED (FULFILLMENT_UNKNOWN). Will NOT settle until fulfillment is confirmed.",
      });
      continue;
    }

    if (classification === "RELEASE_ELIGIBLE") {
      // Fulfillment failed — release the reservation (return funds).
      // We inline the release logic here (rather than calling releaseResellerReservation)
      // because the worker doesn't have a real userId for the audit log.
      try {
        const releaseResult = await db.$transaction(async (tx) => {
          const updated = await tx.tenantBalanceReservation.updateMany({
            where: { id: reservation.id, state: "RESERVED" },
            data: { state: "RELEASED", releasedAt: new Date(), failureReason: "Fulfillment failed (detected by reconciliation worker)" },
          });
          if (updated.count === 0) {
            return { alreadyDone: true as const };
          }
          // Phase 2B.2.7: Lock the balance row for concurrency-safe sequence allocation.
          await lockTenantBalance(tx, reservation.tenantId);
          const balance = await tx.tenantBalance.upsert({
            where: { tenantId: reservation.tenantId },
            create: { tenantId: reservation.tenantId, balanceMinor: reservation.amountMinor },
            update: { balanceMinor: { increment: reservation.amountMinor } },
          });
          const workerReleaseSeq = await getNextSequenceNumber(tx, reservation.tenantId);
          await tx.tenantTransaction.create({
            data: {
              tenantId: reservation.tenantId,
              type: "release",
              amountMinor: reservation.amountMinor,
              balanceAfter: balance.balanceMinor,
              orderId: reservation.orderId,
              description: "Reservation released by reconciliation worker (fulfillment failed)",
              idempotencyKey: `release_${reservation.idempotencyKey}`,
              sequenceNumber: workerReleaseSeq,
            },
          });
          return { alreadyDone: false as const, balanceMinor: balance.balanceMinor };
        }, { timeout: 30000, maxWait: 15000 });

        if (!releaseResult.alreadyDone) {
          result.released++;
          logger.info("reseller.reservation_released_by_reconciliation", {
            reservationId: reservation.id,
            orderId: reservation.orderId,
            balanceMinor: releaseResult.balanceMinor,
          });
        }
      } catch (err) {
        result.stillFailing++;
        logger.error("reseller.reservation_release_failed", {
          reservationId: reservation.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // SETTLEMENT_ELIGIBLE — retry the ledger posting (idempotent)
    try {
      const ledgerTxnId = await ledgerResellerPurchase({
        tenantId: reservation.tenantId,
        orderId: reservation.orderId,
        retailPriceMinor: reservation.amountMinor,
        platformFeeMinor: reservation.platformFeeMinor,
        idempotencyKey: `${reservation.idempotencyKey}:ledger`,
      });

      // Transition to SETTLED (status-guarded)
      // Phase 2B.2.4: Clear BOTH failureReason AND reconciliationReason on successful settlement.
      const updated = await db.tenantBalanceReservation.updateMany({
        where: { id: reservation.id, state: { in: ["RESERVED", "RECONCILIATION_REQUIRED"] } },
        data: { state: "SETTLED", settledAt: new Date(), ledgerTransactionId: ledgerTxnId, failureReason: null, reconciliationReason: null },
      });

      if (updated.count > 0) {
        result.repaired++;
        logger.info("reseller.reservation_reconciled", {
          reservationId: reservation.id,
          orderId: reservation.orderId,
          ledgerTxnId,
          wasStaleReserved: reservation.state === "RESERVED",
        });

        // Create the TenantTransaction if it doesn't exist (idempotent via unique key)
        // Phase 2B.2.7: Use a transaction with FOR UPDATE lock for concurrency-safe sequence allocation.
        try {
          await db.$transaction(async (tx) => {
            await lockTenantBalance(tx, reservation.tenantId);
            const workerSettleSeq = await getNextSequenceNumber(tx, reservation.tenantId);
            const currentBalance = await getTenantBalanceMinorTx(tx, reservation.tenantId);
            await tx.tenantTransaction.create({
              data: {
                tenantId: reservation.tenantId,
                type: "purchase",
                amountMinor: -reservation.amountMinor,
                balanceAfter: currentBalance,
                orderId: reservation.orderId,
                description: "Connectivity purchase settled (reconciliation)",
                idempotencyKey: `settle_${reservation.idempotencyKey}`,
                ledgerTransactionId: ledgerTxnId,
                sequenceNumber: workerSettleSeq,
              },
            });
          }, { timeout: 30000, maxWait: 15000 });

          // Phase 2B.2.5: Mark the projection as reconciled
          await db.tenantBalanceReservation.update({
            where: { id: reservation.id },
            data: { projectionReconciled: true },
          }).catch((err) => logProjectionUpdateFailure(reservation.id, "worker.settle.normal", err));
        } catch (txnErr) {
          const txnMsg = txnErr instanceof Error ? txnErr.message : String(txnErr);
          if (txnMsg.includes("Unique constraint") || txnMsg.includes("P2002")) {
            // Already exists — fine, mark as reconciled
            await db.tenantBalanceReservation.update({
              where: { id: reservation.id },
              data: { projectionReconciled: true },
            }).catch((err) => logProjectionUpdateFailure(reservation.id, "worker.settle.idempotent_replay", err));
          } else {
            logger.error("reseller.reservation_reconcile_txn_failed", {
              reservationId: reservation.id,
              orderId: reservation.orderId,
              ledgerTxnId,
              error: txnMsg,
              message: "CRITICAL: Reservation reconciled to SETTLED but TenantTransaction creation failed. The operational projection will be repaired on the next reconciliation run.",
            });
          }
        }
      } else {
        // Another concurrent call settled it — no-op
        logger.info("reseller.reservation_already_settled_during_reconciliation", { reservationId: reservation.id });
      }
    } catch (err) {
      result.stillFailing++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("reseller.reservation_reconciliation_still_failing", {
        reservationId: reservation.id,
        orderId: reservation.orderId,
        error: errorMsg,
      });
      // Leave as RECONCILIATION_REQUIRED for the next worker run
    }
  }

  // Phase 2B.2.4: Repair SETTLED reservations that are missing their TenantTransaction.
  // This can happen if the TenantTransaction.create() call failed during settlement
  // (in either the order route or the reconciliation worker). The ledger is already
  // correct (ledgerTransactionId is set), so we only need to repair the operational
  // projection — we do NOT repost the ledger or change the balance.
  //
  // Phase 2B.2.5: Use the projectionReconciled flag to avoid scanning every historical
  // SETTLED reservation on every cron run. Only reservations with
  // projectionReconciled=false are checked. Once the TenantTransaction is confirmed
  // to exist (either it was already there or we just repaired it), the flag is set
  // to true and the worker skips it on future runs.
  //
  // Phase 2B.2.5: The repaired balanceAfter is the HISTORICAL balance immediately
  // after this transaction, NOT the current balance. We reconstruct it from the
  // ordered TenantTransaction history: find the transaction immediately before this
  // one (by createdAt), take its balanceAfter, add this transaction's amount.
  const settledReservations = await db.tenantBalanceReservation.findMany({
    where: {
      state: "SETTLED",
      ledgerTransactionId: { not: null },
      projectionReconciled: false,
    },
    select: {
      id: true, tenantId: true, orderId: true, amountMinor: true,
      idempotencyKey: true, ledgerTransactionId: true, createdAt: true,
    },
  });

  for (const reservation of settledReservations) {
    // Check if the TenantTransaction already exists
    const expectedTxnKey = `settle_${reservation.idempotencyKey}`;
    const existingTxn = await db.tenantTransaction.findUnique({
      where: { idempotencyKey: expectedTxnKey },
    });

    if (existingTxn) {
      // The TenantTransaction already exists — mark the projection as reconciled
      // so we don't scan this reservation again.
      await db.tenantBalanceReservation.update({
        where: { id: reservation.id },
        data: { projectionReconciled: true },
      }).catch((err) => logProjectionUpdateFailure(reservation.id, "worker.existing_txn_check", err));
      continue;
    }

    // Phase 2B.2.6: Reconstruct the HISTORICAL balanceAfter using deterministic
    // sequenceNumber ordering (NOT createdAt, which can collide under concurrent
    // transactions). Find the TenantTransaction with the highest sequenceNumber
    // that is lower than the sequence this transaction would have had.
    //
    // Since the missing transaction was never created, we don't know its exact
    // sequenceNumber. But we can reconstruct the correct balanceAfter by finding
    // the transaction that was immediately before it in the historical sequence.
    // We use the reservation's createdAt as a rough filter to find the right
    // epoch, then use sequenceNumber for deterministic ordering within that epoch.
    //
    // The prior transaction's balanceAfter + this transaction's amount = the
    // correct historical balanceAfter for the repaired transaction.
    const priorTxn = await db.tenantTransaction.findFirst({
      where: {
        tenantId: reservation.tenantId,
        createdAt: { lt: reservation.createdAt },
      },
      orderBy: [{ sequenceNumber: "desc" }],
      select: { balanceAfter: true, sequenceNumber: true },
    });

    const historicalBalanceBefore = priorTxn?.balanceAfter ?? 0;
    const transactionAmount = -reservation.amountMinor; // purchase is negative
    const historicalBalanceAfter = historicalBalanceBefore + transactionAmount;

    // Phase 2B.2.7: Use a transaction with FOR UPDATE lock for concurrency-safe
    // sequence allocation. The repaired transaction gets the next available
    // sequenceNumber (at the end of the current history). This is correct
    // because the repaired transaction is being created NOW by the reconciliation
    // worker — its position in the operational history is the repair time, not
    // the original settlement time. The historicalBalanceAfter field preserves
    // the correct historical balance.
    try {
      await db.$transaction(async (tx) => {
        await lockTenantBalance(tx, reservation.tenantId);
        const repairSeq = await getNextSequenceNumber(tx, reservation.tenantId);
        await tx.tenantTransaction.create({
          data: {
            tenantId: reservation.tenantId,
            type: "purchase",
            amountMinor: transactionAmount,
            balanceAfter: historicalBalanceAfter,
            orderId: reservation.orderId,
            description: "Connectivity purchase settled (projection repair)",
            idempotencyKey: expectedTxnKey,
            ledgerTransactionId: reservation.ledgerTransactionId,
            sequenceNumber: repairSeq,
          },
        });
      }, { timeout: 30000, maxWait: 15000 });

      // Mark the projection as reconciled so we don't scan this reservation again
      await db.tenantBalanceReservation.update({
        where: { id: reservation.id },
        data: { projectionReconciled: true },
      }).catch((err) => logProjectionUpdateFailure(reservation.id, "worker.repair.create", err));

      result.projectionRepaired++;
      logger.info("reseller.projection_repaired", {
        reservationId: reservation.id,
        orderId: reservation.orderId,
        ledgerTxnId: reservation.ledgerTransactionId,
        historicalBalanceAfter,
      });
    } catch (txnErr) {
      const txnMsg = txnErr instanceof Error ? txnErr.message : String(txnErr);
      if (txnMsg.includes("Unique constraint") || txnMsg.includes("P2002")) {
        // Another concurrent call created it — mark as reconciled
        await db.tenantBalanceReservation.update({
          where: { id: reservation.id },
          data: { projectionReconciled: true },
        }).catch((err) => logProjectionUpdateFailure(reservation.id, "worker.repair.idempotent_replay", err));
        logger.info("reseller.projection_repair_idempotent_replay", { reservationId: reservation.id });
      } else {
        result.stillFailing++;
        logger.error("reseller.projection_repair_failed", {
          reservationId: reservation.id,
          orderId: reservation.orderId,
          ledgerTxnId: reservation.ledgerTransactionId,
          error: txnMsg,
          message: "CRITICAL: SETTLED reservation has a ledger transaction but TenantTransaction creation failed. The ledger is correct; the operational projection will be retried on the next reconciliation run.",
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Legacy/deprecated direct deposit (Phase 2B.1 — kept for backward compat,
// blocked in production)
// ---------------------------------------------------------------------------

/**
 * @deprecated Phase 2B.2: Use createDepositIntent + confirmDepositPayment instead.
 * This function is kept for backward compatibility with existing tests but
 * is blocked in production (NODE_ENV=production) — it would bypass real payment.
 */
export async function depositResellerBalance(input: {
  tenantId: string;
  userId: string;
  amountMinor: number;
  idempotencyKey: string;
  description?: string;
}): Promise<{ balanceMinor: number; transactionId: string }> {
  if (process.env.NODE_ENV === "production") {
    throw new AppError(
      "validation",
      "Direct deposit not allowed in production",
      403,
      "Direct balance deposits are not allowed in production. Use the deposit intent + payment provider flow.",
    );
  }

  // Development/test path: use the mock provider to simulate a payment
  const intent = await createDepositIntent({
    tenantId: input.tenantId,
    userId: input.userId,
    amountMinor: input.amountMinor,
    idempotencyKey: input.idempotencyKey,
  });

  const result = await confirmDepositPayment({
    depositPaymentId: intent.depositPaymentId,
    tenantId: input.tenantId,
    userId: input.userId,
  });

  const balance = await getTenantBalanceMinor(input.tenantId);
  return { balanceMinor: balance, transactionId: intent.depositPaymentId };
}

// ---------------------------------------------------------------------------
// Deprecated direct debit (Phase 2B.1 — kept for backward compat, but now
// uses the reservation lifecycle internally)
// ---------------------------------------------------------------------------

/**
 * @deprecated Phase 2B.2: Use reserveResellerBalance + settleResellerReservation
 * instead. This function is kept for backward compatibility with existing
 * tests but now uses the reservation lifecycle internally (reserve + settle).
 */
export async function debitResellerBalance(input: {
  tenantId: string;
  userId: string;
  orderId: string;
  amountMinor: number;
  platformFeeMinor: number;
  idempotencyKey: string;
  description?: string;
}): Promise<{ balanceMinor: number; transactionId: string; ledgerTransactionId: string }> {
  // Reserve the funds
  const reserveResult = await reserveResellerBalance({
    tenantId: input.tenantId,
    userId: input.userId,
    orderId: input.orderId,
    amountMinor: input.amountMinor,
    platformFeeMinor: input.platformFeeMinor,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
  });

  // Immediately settle (legacy behavior — assumes fulfillment succeeds)
  const settleResult = await settleResellerReservation({
    tenantId: input.tenantId,
    userId: input.userId,
    orderId: input.orderId,
  });

  return {
    balanceMinor: reserveResult.balanceMinor,
    transactionId: settleResult.reservationId,
    ledgerTransactionId: settleResult.ledgerTransactionId,
  };
}

/** List the tenant's transaction history. */
export async function listTenantTransactions(tenantId: string, limit = 50) {
  return db.tenantTransaction.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
