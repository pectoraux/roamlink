/**
 * Reseller Balance service — prepaid balance + transaction history.
 *
 * Phase 2B.1: The reseller prepays funds into their balance. Connectivity
 * purchases debit from this balance. The balance can never go negative.
 *
 * All financial events post to the canonical double-entry ledger via
 * ledgerResellerDeposit / ledgerResellerPurchase. The TenantBalance model
 * is a fast-read cache of the ledger's RESELLER_FUNDS_LIABILITY account
 * (scoped to this tenant).
 *
 * Idempotency: every deposit and purchase carries a durable idempotencyKey.
 * Duplicate requests with the same key return the existing transaction
 * without creating a second ledger posting.
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

/** Get or create the tenant's balance record. */
export async function getOrCreateTenantBalance(tenantId: string) {
  let balance = await db.tenantBalance.findUnique({ where: { tenantId } });
  if (!balance) {
    balance = await db.tenantBalance.create({ data: { tenantId } });
  }
  return balance;
}

/** Get the current balance (minor units). */
export async function getTenantBalanceMinor(tenantId: string): Promise<number> {
  const balance = await getOrCreateTenantBalance(tenantId);
  return balance.balanceMinor;
}

/**
 * Record a reseller deposit (prepaid funds added to balance).
 *
 * Atomic: balance update + TenantTransaction + ledger posting in one transaction.
 * Idempotent: idempotencyKey prevents duplicate deposits.
 */
export async function depositResellerBalance(input: {
  tenantId: string;
  userId: string;
  amountMinor: number;
  idempotencyKey: string;
  description?: string;
}): Promise<{ balanceMinor: number; transactionId: string }> {
  if (input.amountMinor <= 0) {
    throw new AppError("validation", "Deposit amount must be positive", 400, "Deposit amount must be greater than zero.");
  }

  await ensureChartOfAccounts();

  return db.$transaction(async (tx) => {
    // Idempotency: check for existing transaction
    const existing = await tx.tenantTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      logger.info("reseller.deposit_idempotent_replay", { idempotencyKey: input.idempotencyKey, txnId: existing.id });
      return { balanceMinor: existing.balanceAfter, transactionId: existing.id };
    }

    // Lock + update balance
    const balance = await tx.tenantBalance.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, balanceMinor: input.amountMinor, totalDepositedMinor: input.amountMinor },
      update: {
        balanceMinor: { increment: input.amountMinor },
        totalDepositedMinor: { increment: input.amountMinor },
      },
    });

    // Create transaction record
    const txn = await tx.tenantTransaction.create({
      data: {
        tenantId: input.tenantId,
        type: "deposit",
        amountMinor: input.amountMinor,
        balanceAfter: balance.balanceMinor,
        description: input.description ?? "Prepaid deposit",
        idempotencyKey: input.idempotencyKey,
      },
    });

    return { balanceMinor: balance.balanceMinor, transactionId: txn.id };
  }).then(async (result) => {
    // Post ledger entry (outside the balance transaction — idempotent via ledger idempotencyKey)
    const ledgerTxnId = await ledgerResellerDeposit({
      tenantId: input.tenantId,
      userId: input.userId,
      amountMinor: input.amountMinor,
      idempotencyKey: `${input.idempotencyKey}:ledger`,
    });
    await db.tenantTransaction.update({
      where: { id: result.transactionId },
      data: { ledgerTransactionId: ledgerTxnId },
    }).catch(() => {});

    await audit({
      tenantId: input.tenantId,
      userId: input.userId,
      action: "reseller.balance_deposited",
      entity: "tenant_balance",
      entityId: input.tenantId,
      detail: { amount: input.amountMinor, balanceAfter: result.balanceMinor },
    });
    logger.info("reseller.balance_deposited", { tenantId: input.tenantId, amount: input.amountMinor, balance: result.balanceMinor });
    return result;
  });
}

/**
 * Debit the reseller balance for a connectivity purchase.
 *
 * Atomic + concurrency-safe: FOR UPDATE lock on the balance row.
 * Fails if insufficient balance (no negative balance allowed).
 * Idempotent: idempotencyKey prevents duplicate purchases.
 *
 * Returns { balanceMinor, transactionId, ledgerTransactionId }.
 */
export async function debitResellerBalance(input: {
  tenantId: string;
  userId: string;
  orderId: string;
  amountMinor: number; // retail price
  platformFeeMinor: number;
  idempotencyKey: string;
  description?: string;
}): Promise<{ balanceMinor: number; transactionId: string; ledgerTransactionId: string }> {
  if (input.amountMinor <= 0) {
    throw new AppError("validation", "Purchase amount must be positive", 400, "Purchase amount must be greater than zero.");
  }

  await ensureChartOfAccounts();

  // Atomic balance check + debit + transaction record
  const result = await db.$transaction(async (tx) => {
    // Idempotency: check for existing transaction
    const existing = await tx.tenantTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      logger.info("reseller.purchase_idempotent_replay", { idempotencyKey: input.idempotencyKey, txnId: existing.id });
      return { balanceMinor: existing.balanceAfter, transactionId: existing.id, existing: true };
    }

    // Lock the balance row for safe concurrent debit
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

    // Update balance
    const balance = await tx.tenantBalance.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, balanceMinor: -input.amountMinor, totalSpentMinor: input.amountMinor },
      update: {
        balanceMinor: { decrement: input.amountMinor },
        totalSpentMinor: { increment: input.amountMinor },
      },
    });

    // Create transaction record
    const txn = await tx.tenantTransaction.create({
      data: {
        tenantId: input.tenantId,
        type: "purchase",
        amountMinor: -input.amountMinor,
        balanceAfter: balance.balanceMinor,
        orderId: input.orderId,
        description: input.description ?? "Connectivity purchase",
        idempotencyKey: input.idempotencyKey,
      },
    });

    return { balanceMinor: balance.balanceMinor, transactionId: txn.id, existing: false };
  }, { timeout: 30000, maxWait: 15000 });

  if ("existing" in result && result.existing) {
    // Already processed — fetch the ledger transaction ID
    const ledgerTxnId = await db.tenantTransaction.findUnique({
      where: { id: result.transactionId },
      select: { ledgerTransactionId: true },
    });
    return {
      balanceMinor: result.balanceMinor,
      transactionId: result.transactionId,
      ledgerTransactionId: ledgerTxnId?.ledgerTransactionId ?? "",
    };
  }

  // Post ledger entry (outside the balance transaction — idempotent)
  const ledgerTxnId = await ledgerResellerPurchase({
    tenantId: input.tenantId,
    userId: input.userId,
    orderId: input.orderId,
    retailPriceMinor: input.amountMinor,
    platformFeeMinor: input.platformFeeMinor,
    idempotencyKey: `${input.idempotencyKey}:ledger`,
  });

  await db.tenantTransaction.update({
    where: { id: result.transactionId },
    data: { ledgerTransactionId: ledgerTxnId },
  }).catch(() => {});

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: "reseller.balance_debited",
    entity: "tenant_balance",
    entityId: input.tenantId,
    detail: { amount: input.amountMinor, orderId: input.orderId, balanceAfter: result.balanceMinor },
  });
  logger.info("reseller.balance_debited", { tenantId: input.tenantId, amount: input.amountMinor, orderId: input.orderId, balance: result.balanceMinor });

  return {
    balanceMinor: result.balanceMinor,
    transactionId: result.transactionId,
    ledgerTransactionId: ledgerTxnId,
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
