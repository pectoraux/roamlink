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
