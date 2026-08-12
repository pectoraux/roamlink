/**
 * Provider Credit Account service — tracks provider credit facilities.
 *
 * The Airalo $10K credit facility is a financial LIABILITY, not cash.
 * This service tracks outstanding liability, utilization, and threshold alerts.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

/** Ensure a provider credit account exists (creates with defaults if not). */
export async function ensureProviderAccount(provider: string, creditLimitMinor?: number): Promise<void> {
  const existing = await db.providerCreditAccount.findUnique({ where: { provider } });
  if (existing) return;

  // Default credit limits (Airalo = $10,000 = 1,000,000 minor units)
  const defaultLimits: Record<string, number> = {
    airalo: 1_000_000,
    mock: 1_000_000, // same as Airalo for dev
  };

  await db.providerCreditAccount.create({
    data: {
      provider,
      creditLimit: creditLimitMinor ?? defaultLimits[provider] ?? 500_000,
      currency: "USD",
    },
  });
  logger.info("provider_credit.account_created", { provider, creditLimit: creditLimitMinor ?? defaultLimits[provider] ?? 500_000 });
}

/** Get a provider's credit account with utilization. */
export async function getProviderCredit(provider: string) {
  const account = await db.providerCreditAccount.findUnique({
    where: { provider },
    include: { invoices: { orderBy: { createdAt: "desc" }, take: 5 } },
  });
  if (!account) return null;

  const utilization = account.creditLimit > 0
    ? (account.outstandingLiability / account.creditLimit) * 100
    : 0;

  const availableCredit = account.creditLimit - account.outstandingLiability - account.pendingCommitments;

  // Determine alert level
  let alertLevel: "none" | "info" | "warn" | "elevated" | "critical" | "emergency" = "none";
  if (utilization >= account.thresholdEmergency) alertLevel = "emergency";
  else if (utilization >= account.thresholdCritical) alertLevel = "critical";
  else if (utilization >= account.thresholdElevated) alertLevel = "elevated";
  else if (utilization >= account.thresholdWarn) alertLevel = "warn";
  else if (utilization >= account.thresholdInfo) alertLevel = "info";

  return {
    ...account,
    utilization: Math.round(utilization * 100) / 100,
    availableCredit,
    alertLevel,
    canCommit: alertLevel !== "critical" && alertLevel !== "emergency",
  };
}

/** Check if a provider can accept a new commitment of the given amount. */
export async function canProviderCommit(provider: string, amountMinor: number): Promise<{ canCommit: boolean; reason?: string }> {
  const credit = await getProviderCredit(provider);
  if (!credit) return { canCommit: true, reason: "No credit account — assuming pay-as-you-go" };

  if (!credit.canCommit) {
    return {
      canCommit: false,
      reason: `Provider credit at ${credit.utilization}% utilization (alert: ${credit.alertLevel}). New commitments restricted.`,
    };
  }

  if (credit.availableCredit < amountMinor) {
    return {
      canCommit: false,
      reason: `Insufficient credit: need ${amountMinor}, available ${credit.availableCredit}`,
    };
  }

  return { canCommit: true };
}

/** Increase pending commitments (when an order is in-flight). */
export async function addPendingCommitment(provider: string, amountMinor: number): Promise<void> {
  await ensureProviderAccount(provider);
  await db.providerCreditAccount.update({
    where: { provider },
    data: { pendingCommitments: { increment: amountMinor } },
  });
}

/** Convert pending commitment to actual liability (when order completes). */
export async function settleCommitment(provider: string, amountMinor: number): Promise<void> {
  const account = await db.providerCreditAccount.findUnique({ where: { provider } });
  if (!account) return;

  await db.providerCreditAccount.update({
    where: { provider },
    data: {
      pendingCommitments: { decrement: Math.min(account.pendingCommitments, amountMinor) },
      outstandingLiability: { increment: amountMinor },
    },
  });
}

/** Record a provider invoice. */
export async function recordProviderInvoice(input: {
  provider: string;
  providerInvoiceId: string;
  amountMinor: number;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
}): Promise<string> {
  const account = await db.providerCreditAccount.findUnique({ where: { provider: input.provider } });
  if (!account) throw new AppError("not_found", "Provider account not found", 404, "Provider credit account not found.");

  const invoice = await db.providerInvoice.create({
    data: {
      providerAccountId: account.id,
      providerInvoiceId: input.providerInvoiceId,
      amountMinor: input.amountMinor,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      dueDate: input.dueDate,
      status: "pending",
    },
  });

  // Increase invoiced amount on the account
  await db.providerCreditAccount.update({
    where: { id: account.id },
    data: {
      invoicedAmount: { increment: input.amountMinor },
      lastInvoiceDate: new Date(),
    },
  });

  logger.info("provider_credit.invoice_recorded", { provider: input.provider, invoiceId: invoice.id, amount: input.amountMinor });
  return invoice.id;
}

/** Mark a provider invoice as paid. */
export async function payProviderInvoice(invoiceId: string): Promise<void> {
  const invoice = await db.providerInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new AppError("not_found", "Invoice not found", 404, "Invoice not found.");

  await db.$transaction([
    db.providerInvoice.update({
      where: { id: invoiceId },
      data: { status: "paid", paidAt: new Date() },
    }),
    db.providerCreditAccount.update({
      where: { id: invoice.providerAccountId },
      data: {
        paidAmount: { increment: invoice.amountMinor },
        outstandingLiability: { decrement: Math.min(invoice.amountMinor, (await db.providerCreditAccount.findUnique({ where: { id: invoice.providerAccountId } }))!.outstandingLiability) },
      },
    }),
  ]);

  logger.info("provider_credit.invoice_paid", { invoiceId, amount: invoice.amountMinor });
}

/** Get all provider credit accounts (for admin dashboard). */
export async function getAllProviderAccounts() {
  const accounts = await db.providerCreditAccount.findMany({
    include: { invoices: { orderBy: { createdAt: "desc" }, take: 3 } },
  });
  return accounts.map((a) => {
    const utilization = a.creditLimit > 0 ? (a.outstandingLiability / a.creditLimit) * 100 : 0;
    return {
      ...a,
      utilization: Math.round(utilization * 100) / 100,
      availableCredit: a.creditLimit - a.outstandingLiability - a.pendingCommitments,
    };
  });
}

// ===========================================================================
// Phase 2C — Provider Credit Reservations
// ===========================================================================
// A reservation atomically moves `amountMinor` from a provider's available
// credit into `pendingCommitments` while the orchestrator is fulfilling an
// order. The reservation is either:
//   - settled (pendingCommitments → outstandingLiability) when fulfillment
//     succeeds, OR
//   - released (pendingCommitments → available credit) when fulfillment fails.
//
// All three operations are idempotent via reservationId / reservation status.

/**
 * Atomically reserve a provider credit commitment. Idempotent via
 * reservationId — re-calling with the same id returns the existing record.
 *
 * Conditional UPDATE: only succeeds if the provider has enough available
 * credit. If the provider has no ProviderCreditAccount, the reservation is
 * still recorded (assumes pay-as-you-go) but no account balance is touched.
 */
export async function reserveProviderCommitment(input: {
  reservationId: string;
  provider: string;
  amountMinor: number;
  orderId?: string;
}): Promise<{ reservationId: string; status: string; amountMinor: number }> {
  // Idempotency: return existing reservation if present.
  const existing = await db.providerCreditReservation.findUnique({
    where: { reservationId: input.reservationId },
  });
  if (existing) {
    logger.info("provider_credit.reservation_replay", {
      reservationId: input.reservationId,
      status: existing.status,
    });
    return {
      reservationId: existing.reservationId,
      status: existing.status,
      amountMinor: existing.amountMinor,
    };
  }

  await ensureProviderAccount(input.provider);

  // Atomic conditional UPDATE: only increment pendingCommitments if the
  // available credit (creditLimit - outstandingLiability - pendingCommitments)
  // is >= amountMinor. If not, throw.
  //
  // SQLite/Prisma: we read-then-update inside a transaction; the conditional
  // is enforced by re-checking inside the transaction.
  const result = await db.$transaction(async (tx) => {
    const account = await tx.providerCreditAccount.findUnique({
      where: { provider: input.provider },
    });
    if (!account) {
      // No account → record reservation only (pay-as-you-go).
      return { reserved: true, account: null };
    }

    const available = account.creditLimit - account.outstandingLiability - account.pendingCommitments;
    if (available < input.amountMinor) {
      throw new AppError(
        "conflict",
        `Insufficient provider credit for ${input.provider}: need ${input.amountMinor}, available ${available}`,
        409,
        "The supplier cannot accept this commitment right now.",
      );
    }

    // Threshold guard: don't reserve if it would push past critical threshold.
    const newUtilization = ((account.outstandingLiability + account.pendingCommitments + input.amountMinor) / account.creditLimit) * 100;
    if (newUtilization >= account.thresholdCritical) {
      throw new AppError(
        "conflict",
        `Provider ${input.provider} at critical utilization (${Math.round(newUtilization)}%)`,
        409,
        "The supplier is at critical credit utilization.",
      );
    }

    await tx.providerCreditAccount.update({
      where: { id: account.id },
      data: { pendingCommitments: { increment: input.amountMinor } },
    });
    return { reserved: true, account };
  });

  const reservation = await db.providerCreditReservation.create({
    data: {
      reservationId: input.reservationId,
      provider: input.provider,
      amountMinor: input.amountMinor,
      status: "reserved",
      orderId: input.orderId ?? null,
    },
  });

  logger.info("provider_credit.reserved", {
    reservationId: reservation.reservationId,
    provider: input.provider,
    amount: input.amountMinor,
    hadAccount: result.account != null,
  });
  return {
    reservationId: reservation.reservationId,
    status: reservation.status,
    amountMinor: reservation.amountMinor,
  };
}

/**
 * Settle a reservation: move the reserved amount from pendingCommitments to
 * outstandingLiability. Idempotent — a settled reservation cannot be re-settled.
 */
export async function settleReservation(reservationId: string): Promise<void> {
  const reservation = await db.providerCreditReservation.findUnique({
    where: { reservationId },
  });
  if (!reservation) {
    logger.warn("provider_credit.settle_missing", { reservationId });
    return;
  }
  if (reservation.status === "settled") {
    logger.info("provider_credit.settle_replay", { reservationId });
    return;
  }
  if (reservation.status === "released") {
    throw new AppError(
      "conflict",
      `Cannot settle released reservation ${reservationId}`,
      409,
      "Reservation was already released.",
    );
  }

  await db.$transaction(async (tx) => {
    const account = await tx.providerCreditAccount.findUnique({
      where: { provider: reservation.provider },
    });
    if (account) {
      await tx.providerCreditAccount.update({
        where: { id: account.id },
        data: {
          pendingCommitments: { decrement: Math.min(account.pendingCommitments, reservation.amountMinor) },
          outstandingLiability: { increment: reservation.amountMinor },
        },
      });
    }
    await tx.providerCreditReservation.update({
      where: { id: reservation.id },
      data: { status: "settled", settledAt: new Date() },
    });
  });

  logger.info("provider_credit.settled", {
    reservationId,
    provider: reservation.provider,
    amount: reservation.amountMinor,
  });
}

/**
 * Release a reservation: return the reserved amount to available credit.
 * Idempotent — a released reservation cannot be re-released or settled.
 */
export async function releaseReservation(reservationId: string): Promise<void> {
  const reservation = await db.providerCreditReservation.findUnique({
    where: { reservationId },
  });
  if (!reservation) {
    logger.warn("provider_credit.release_missing", { reservationId });
    return;
  }
  if (reservation.status === "released") {
    logger.info("provider_credit.release_replay", { reservationId });
    return;
  }
  if (reservation.status === "settled") {
    throw new AppError(
      "conflict",
      `Cannot release settled reservation ${reservationId}`,
      409,
      "Reservation was already settled.",
    );
  }

  await db.$transaction(async (tx) => {
    const account = await tx.providerCreditAccount.findUnique({
      where: { provider: reservation.provider },
    });
    if (account) {
      await tx.providerCreditAccount.update({
        where: { id: account.id },
        data: {
          pendingCommitments: { decrement: Math.min(account.pendingCommitments, reservation.amountMinor) },
        },
      });
    }
    await tx.providerCreditReservation.update({
      where: { id: reservation.id },
      data: { status: "released", releasedAt: new Date() },
    });
  });

  logger.info("provider_credit.released", {
    reservationId,
    provider: reservation.provider,
    amount: reservation.amountMinor,
  });
}

/** Look up a reservation by id (for status checks). */
export async function getReservation(reservationId: string) {
  return db.providerCreditReservation.findUnique({
    where: { reservationId },
  });
}
