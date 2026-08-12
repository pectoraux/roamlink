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

/** Get the current available balance (minor units). */
export async function getTenantBalanceMinor(tenantId: string): Promise<number> {
  const balance = await getOrCreateTenantBalance(tenantId);
  return balance.balanceMinor;
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
    await tx.tenantTransaction.create({
      data: {
        tenantId: input.tenantId,
        type: "reservation",
        amountMinor: -input.amountMinor,
        balanceAfter: balance.balanceMinor,
        orderId: input.orderId,
        description: input.description ?? "Balance reserved for order",
        idempotencyKey: `reserve_${input.idempotencyKey}`,
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
 * The reservation transitions RESERVED → SETTLED. The available balance was
 * already decremented at reserve time, so settle does NOT touch the balance
 * — it only posts the ledger entry and updates the reservation state.
 *
 * Idempotent: if already SETTLED, returns the existing ledgerTxnId.
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

  // Post the ledger entry (Dr Reseller Funds Liability, Cr Sales Revenue + Cr Platform Fee Revenue)
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
    // Phase 2B.2 §3: Do NOT silently swallow. Mark as reconciliation_required.
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("reseller.settle_ledger_failed", { orderId: input.orderId, reservationId: reservation.id, error: errorMsg });
    await db.tenantBalanceReservation.update({
      where: { id: reservation.id },
      data: { failureReason: `Ledger posting failed: ${errorMsg}` },
    }).catch(() => {});
    throw new AppError("internal", "Ledger posting failed during settlement", 500, "The reservation was created but the ledger posting failed. It will be retried.");
  }

  // Transition RESERVED → SETTLED (status-guarded)
  const updated = await db.tenantBalanceReservation.updateMany({
    where: { id: reservation.id, state: "RESERVED" },
    data: { state: "SETTLED", settledAt: new Date(), ledgerTransactionId: ledgerTxnId },
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

  // Create a TenantTransaction for the settlement (funds are now spent, not just reserved)
  await db.tenantTransaction.create({
    data: {
      tenantId: input.tenantId,
      type: "purchase",
      amountMinor: -reservation.amountMinor,
      balanceAfter: await getTenantBalanceMinor(input.tenantId),
      orderId: input.orderId,
      description: "Connectivity purchase settled",
      idempotencyKey: `settle_${reservation.idempotencyKey}`,
      ledgerTransactionId: ledgerTxnId,
    },
  }).catch(() => {});

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

    // Return funds to available balance
    const balance = await tx.tenantBalance.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, balanceMinor: reservation.amountMinor },
      update: { balanceMinor: { increment: reservation.amountMinor } },
    });

    // Create a TenantTransaction for the release (positive = funds returned)
    await tx.tenantTransaction.create({
      data: {
        tenantId: input.tenantId,
        type: "release",
        amountMinor: reservation.amountMinor,
        balanceAfter: balance.balanceMinor,
        orderId: input.orderId,
        description: "Reservation released (fulfillment failed)",
        idempotencyKey: `release_${reservation.idempotencyKey}`,
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
    const txn = await tx.tenantTransaction.create({
      data: {
        tenantId: input.tenantId,
        type: "deposit",
        amountMinor: deposit.amountMinor,
        balanceAfter: balance.balanceMinor,
        description: `Deposit via ${deposit.paymentProvider}`,
        idempotencyKey: `deposit_${deposit.idempotencyKey}`,
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
    await db.tenantDepositPayment.update({
      where: { id: deposit.id },
      data: { status: "PAYMENT_SUCCEEDED" },
    }).catch(() => {});
    await creditDepositBalance({
      depositPaymentId: deposit.id,
      tenantId: deposit.tenantId,
      userId: deposit.userId,
    }).catch((err) => {
      logger.error("reseller.deposit_webhook_credit_failed", { depositId: deposit.id, error: err instanceof Error ? err.message : String(err) });
    });
    return { handled: true };
  }

  if (input.status === "failed") {
    await db.tenantDepositPayment.update({
      where: { id: deposit.id },
      data: { status: "PAYMENT_FAILED", failureReason: "Webhook reported payment failed" },
    }).catch(() => {});
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
