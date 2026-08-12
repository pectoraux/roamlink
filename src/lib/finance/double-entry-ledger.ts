/**
 * Double-Entry Ledger — the canonical financial record.
 *
 * Each commercial event is recorded as a LedgerTransaction with two or more
 * LedgerEntry rows (debits + credits) on LedgerAccounts. Every entry sums to
 * zero, so the ledger is always balanced.
 *
 * Standard chart of accounts:
 *
 *   1000 Cash (payment processor)          asset     debit
 *   1200 Accounts Receivable               asset     debit
 *   1500 Inventory (eSIM credits prepaid)  asset     debit
 *   2000 Accounts Payable (suppliers)      liability credit
 *   2100 Provider Credit Liability         liability credit
 *   2200 Customer Credit Liability         liability credit
 *   3000 Contributed Capital               equity    credit
 *   4000 Sales Revenue                     revenue   credit
 *   5000 Cost of Goods Sold (COGS)         expense   debit
 *   6000 Payment Processing Fees           expense   debit
 *
 * Phase 2E.5: Customer credit (referral rewards, promo credits, refunds-to-
 * credit) is a LIABILITY, not cash. When a customer uses credit to pay for
 * a purchase or renewal, the ledger must:
 *   - Dr Customer Credit Liability (reducing the obligation)
 *   - Cr Sales Revenue (recognizing the revenue)
 *   - Dr Cash only for the cash portion (minus payment fee)
 *   - Dr Payment Fees only on the cash portion
 *
 * The legacy single-entry `recordFinancialEvent` (FinancialTransaction) is
 * preserved for backward compatibility with admin dashboards; the double-
 * entry ledger is the canonical financial truth for Phase 2C.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Account codes
// ---------------------------------------------------------------------------

export const ACCOUNT_CODES = {
  CASH: "1000",
  ACCOUNTS_RECEIVABLE: "1200",
  INVENTORY: "1500",
  ACCOUNTS_PAYABLE: "2000",
  PROVIDER_CREDIT_LIABILITY: "2100",
  CUSTOMER_CREDIT_LIABILITY: "2200",
  CONTRIBUTED_CAPITAL: "3000",
  SALES_REVENUE: "4000",
  COGS: "5000",
  PAYMENT_FEES: "6000",
  PROMOTIONAL_EXPENSE: "7000",
} as const;

const CHART_OF_ACCOUNTS: Array<{
  code: string;
  name: string;
  type: string;
  normalBalance: "debit" | "credit";
}> = [
  { code: ACCOUNT_CODES.CASH, name: "Cash (Payment Processor)", type: "asset", normalBalance: "debit" },
  { code: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, name: "Accounts Receivable", type: "asset", normalBalance: "debit" },
  { code: ACCOUNT_CODES.INVENTORY, name: "Inventory (eSIM Credits Prepaid)", type: "asset", normalBalance: "debit" },
  { code: ACCOUNT_CODES.ACCOUNTS_PAYABLE, name: "Accounts Payable (Suppliers)", type: "liability", normalBalance: "credit" },
  { code: ACCOUNT_CODES.PROVIDER_CREDIT_LIABILITY, name: "Provider Credit Liability", type: "liability", normalBalance: "credit" },
  { code: ACCOUNT_CODES.CUSTOMER_CREDIT_LIABILITY, name: "Customer Credit Liability", type: "liability", normalBalance: "credit" },
  { code: ACCOUNT_CODES.CONTRIBUTED_CAPITAL, name: "Contributed Capital", type: "equity", normalBalance: "credit" },
  { code: ACCOUNT_CODES.SALES_REVENUE, name: "Sales Revenue", type: "revenue", normalBalance: "credit" },
  { code: ACCOUNT_CODES.COGS, name: "Cost of Goods Sold", type: "expense", normalBalance: "debit" },
  { code: ACCOUNT_CODES.PAYMENT_FEES, name: "Payment Processing Fees", type: "expense", normalBalance: "debit" },
  { code: ACCOUNT_CODES.PROMOTIONAL_EXPENSE, name: "Promotional Expense", type: "expense", normalBalance: "debit" },
];

/** Idempotently ensure the standard chart of accounts exists. */
export async function ensureChartOfAccounts(): Promise<void> {
  for (const a of CHART_OF_ACCOUNTS) {
    const existing = await db.ledgerAccount.findUnique({ where: { code: a.code } });
    if (!existing) {
      await db.ledgerAccount.create({
        data: {
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export type EntryInput = {
  accountCode: string;
  direction: "debit" | "credit";
  amountMinor: number;
};

export type PostLedgerInput = {
  type: string;
  description?: string;
  reference?: string;
  currency?: string;
  idempotencyKey?: string;
  userId?: string;
  organizationId?: string;
  orderId?: string;
  provider?: string;
  providerTxnId?: string;
  entries: EntryInput[];
};

/**
 * Post a balanced ledger transaction. Validates that debits = credits, then
 * writes the transaction + entries atomically. Idempotent via idempotencyKey.
 */
export async function postLedgerTransaction(input: PostLedgerInput): Promise<string> {
  if (input.entries.length < 2) {
    throw new AppError("validation", "Ledger transaction requires at least 2 entries", 400, "Invalid ledger entry.");
  }

  // Idempotency: return existing transaction if idempotencyKey matches.
  if (input.idempotencyKey) {
    const existing = await db.ledgerTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { entries: true },
    });
    if (existing) {
      logger.info("ledger.de.replay", { txnId: existing.id, type: input.type });
      return existing.id;
    }
  }

  // Validate balance: sum(debits) === sum(credits)
  const debitTotal = input.entries.filter((e) => e.direction === "debit").reduce((s, e) => s + e.amountMinor, 0);
  const creditTotal = input.entries.filter((e) => e.direction === "credit").reduce((s, e) => s + e.amountMinor, 0);
  if (debitTotal !== creditTotal) {
    throw new AppError(
      "validation",
      `Unbalanced ledger: debits=${debitTotal} credits=${creditTotal}`,
      400,
      "Ledger entry is unbalanced.",
    );
  }
  if (debitTotal === 0) {
    throw new AppError("validation", "Ledger transaction cannot have zero amount", 400, "Invalid ledger entry.");
  }

  await ensureChartOfAccounts();

  // Validate that all referenced account codes exist.
  const codes = Array.from(new Set(input.entries.map((e) => e.accountCode)));
  const accounts = await db.ledgerAccount.findMany({ where: { code: { in: codes } } });
  if (accounts.length !== codes.length) {
    const found = new Set(accounts.map((a) => a.code));
    const missing = codes.filter((c) => !found.has(c));
    throw new AppError("validation", `Unknown account codes: ${missing.join(", ")}`, 400, "Invalid ledger configuration.");
  }

  const result = await db.$transaction(async (tx) => {
    const txn = await tx.ledgerTransaction.create({
      data: {
        type: input.type,
        description: input.description ?? null,
        reference: input.reference ?? null,
        currency: input.currency ?? "USD",
        status: "posted",
        idempotencyKey: input.idempotencyKey ?? null,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        orderId: input.orderId ?? null,
        provider: input.provider ?? null,
        providerTxnId: input.providerTxnId ?? null,
        postedAt: new Date(),
      },
    });

    for (const e of input.entries) {
      const acct = accounts.find((a) => a.code === e.accountCode)!;
      await tx.ledgerEntry.create({
        data: {
          transactionId: txn.id,
          accountId: acct.id,
          direction: e.direction,
          amountMinor: e.amountMinor,
          currency: input.currency ?? "USD",
        },
      });
    }
    return txn;
  });

  logger.info("ledger.de.posted", {
    txnId: result.id,
    type: input.type,
    amount: debitTotal,
    orderId: input.orderId,
  });
  return result.id;
}

// ---------------------------------------------------------------------------
// Standard journal entries
// ---------------------------------------------------------------------------

/**
 * Record a customer payment:
 *   Debit  Cash                          customerPrice
 *   Credit Sales Revenue                  customerPrice - paymentFee
 *   Credit Payment Processing Fees        paymentFee (contra-revenue, normalized as expense here)
 *
 * Wait — payment fees are an expense, not a contra-revenue. The standard
 * journal entry is:
 *   Debit  Cash                          customerPrice - paymentFee
 *   Debit  Payment Processing Fees       paymentFee
 *   Credit Sales Revenue                  customerPrice
 */
/**
 * Record a customer payment, correctly distinguishing cash vs credit funding.
 *
 * Phase 2E.5: When customer credit funds part of the payment, the ledger
 * must NOT record the credit portion as cash. Instead:
 *
 *   For the cash portion:
 *     Debit  Cash (Payment Processor)     cashPortion - paymentFee
 *     Debit  Payment Processing Fees      paymentFee
 *   For the credit portion:
 *     Debit  Customer Credit Liability    creditPortion
 *   For the total:
 *     Credit Sales Revenue                cashPortion + creditPortion
 *
 * If paidFromCreditMinor is 0 (fully cash-funded), this is equivalent to the
 * original behavior:
 *     Debit  Cash                         revenue - fee
 *     Debit  Payment Fees                 fee
 *     Credit Sales Revenue                revenue
 */
export async function ledgerCustomerPayment(input: {
  userId?: string;
  orderId?: string;
  customerPriceMinor: number;
  paymentFeeMinor: number;
  paidFromCreditMinor?: number;
  currency?: string;
  provider?: string;
  providerTxnId?: string;
  idempotencyKey: string;
}): Promise<string> {
  const revenue = input.customerPriceMinor;
  const fee = input.paymentFeeMinor;
  const creditPortion = input.paidFromCreditMinor ?? 0;
  const cashPortion = revenue - creditPortion;
  const cashReceived = cashPortion - fee; // cash net of payment fee

  const entries: Array<{ accountCode: string; direction: "debit" | "credit"; amountMinor: number }> = [];

  // Cash portion (only if > 0)
  if (cashReceived > 0) {
    entries.push({ accountCode: ACCOUNT_CODES.CASH, direction: "debit", amountMinor: cashReceived });
  }
  // Payment fee (only on cash portion)
  if (fee > 0) {
    entries.push({ accountCode: ACCOUNT_CODES.PAYMENT_FEES, direction: "debit", amountMinor: fee });
  }
  // Credit portion (reduces customer credit liability)
  if (creditPortion > 0) {
    entries.push({ accountCode: ACCOUNT_CODES.CUSTOMER_CREDIT_LIABILITY, direction: "debit", amountMinor: creditPortion });
  }
  // Total revenue
  entries.push({ accountCode: ACCOUNT_CODES.SALES_REVENUE, direction: "credit", amountMinor: revenue });

  return postLedgerTransaction({
    type: "CUSTOMER_PAYMENT",
    description: `Customer payment for ${input.orderId ?? "(none)"} (cash=${cashPortion}, credit=${creditPortion})`,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    userId: input.userId,
    orderId: input.orderId,
    provider: input.provider,
    providerTxnId: input.providerTxnId,
    entries,
  });
}

/**
 * Record customer credit issuance (referral reward, promo credit, refund-to-credit).
 *   Credit Customer Credit Liability   amount
 *   Debit Promotional Expense           amount
 * (or Debit Contributed Capital for non-expense credits)
 */
export async function ledgerCreditIssuance(input: {
  userId?: string;
  orderId?: string;
  amountMinor: number;
  reason?: string;
  currency?: string;
  idempotencyKey: string;
}): Promise<string> {
  return postLedgerTransaction({
    type: "CREDIT_ISSUANCE",
    description: input.reason ?? `Credit issuance for user ${input.userId ?? "(none)"}`,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    userId: input.userId,
    orderId: input.orderId,
    entries: [
      { accountCode: "7000", direction: "debit", amountMinor: input.amountMinor }, // Promotional Expense
      { accountCode: ACCOUNT_CODES.CUSTOMER_CREDIT_LIABILITY, direction: "credit", amountMinor: input.amountMinor },
    ],
  });
}

/**
 * Record a provider purchase (COGS):
 *   Debit  Cost of Goods Sold            wholesalePrice
 *   Credit Provider Credit Liability      wholesalePrice
 */
export async function ledgerProviderPurchase(input: {
  userId?: string;
  orderId?: string;
  provider: string;
  providerTxnId?: string;
  wholesalePriceMinor: number;
  currency?: string;
  idempotencyKey: string;
}): Promise<string> {
  return postLedgerTransaction({
    type: "PROVIDER_PURCHASE",
    description: `Provider purchase for order ${input.orderId ?? "(none)"} via ${input.provider}`,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    userId: input.userId,
    orderId: input.orderId,
    provider: input.provider,
    providerTxnId: input.providerTxnId,
    entries: [
      { accountCode: ACCOUNT_CODES.COGS, direction: "debit", amountMinor: input.wholesalePriceMinor },
      { accountCode: ACCOUNT_CODES.PROVIDER_CREDIT_LIABILITY, direction: "credit", amountMinor: input.wholesalePriceMinor },
    ],
  });
}

/**
 * Record just the payment processing fee (when the customer payment has
 * already been recorded and only the fee breakdown needs to be added).
 * Rarely used directly — `ledgerCustomerPayment` includes the fee.
 */
export async function ledgerPaymentFee(input: {
  userId?: string;
  orderId?: string;
  paymentFeeMinor: number;
  currency?: string;
  provider?: string;
  idempotencyKey: string;
}): Promise<string> {
  return postLedgerTransaction({
    type: "PAYMENT_FEE",
    description: `Payment processing fee for order ${input.orderId ?? "(none)"}`,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    userId: input.userId,
    orderId: input.orderId,
    provider: input.provider,
    entries: [
      { accountCode: ACCOUNT_CODES.PAYMENT_FEES, direction: "debit", amountMinor: input.paymentFeeMinor },
      { accountCode: ACCOUNT_CODES.CASH, direction: "credit", amountMinor: input.paymentFeeMinor },
    ],
  });
}

// ---------------------------------------------------------------------------
// Derived balances / summaries
// ---------------------------------------------------------------------------

export type DerivedFinancialSummary = {
  revenueMinor: number;
  cogsMinor: number;
  grossProfitMinor: number;
  paymentFeesMinor: number;
  contributionProfitMinor: number;
  transactionCount: number;
};

/**
 * Aggregate the ledger entries into a derived financial summary across a date
 * range. Used by admin dashboards. Mirrors the legacy `getFinancialSummary`
 * but sourced from the double-entry ledger.
 */
export async function getDerivedFinancialSummary(
  startDate: Date,
  endDate: Date,
): Promise<DerivedFinancialSummary> {
  const entries = await db.ledgerEntry.findMany({
    where: {
      createdAt: { gte: startDate, lte: endDate },
      account: { code: { in: [ACCOUNT_CODES.SALES_REVENUE, ACCOUNT_CODES.COGS, ACCOUNT_CODES.PAYMENT_FEES] } },
    },
    include: { account: true },
  });

  let revenue = 0;
  let cogs = 0;
  let paymentFees = 0;
  const seenTxnIds = new Set<string>();

  for (const e of entries) {
    seenTxnIds.add(e.transactionId);
    const signed = signedAmount(e.direction, e.amountMinor, e.account.normalBalance as "debit" | "credit");
    if (e.account.code === ACCOUNT_CODES.SALES_REVENUE) revenue += signed;
    else if (e.account.code === ACCOUNT_CODES.COGS) cogs += signed;
    else if (e.account.code === ACCOUNT_CODES.PAYMENT_FEES) paymentFees += signed;
  }

  const grossProfit = revenue - cogs;
  const contributionProfit = grossProfit - paymentFees;

  return {
    revenueMinor: revenue,
    cogsMinor: cogs,
    grossProfitMinor: grossProfit,
    paymentFeesMinor: paymentFees,
    contributionProfitMinor: contributionProfit,
    transactionCount: seenTxnIds.size,
  };
}

/** Convert a direction + amount into a signed amount based on normal balance. */
function signedAmount(direction: string, amount: number, normalBalance: "debit" | "credit"): number {
  // Positive when direction matches normal balance, negative otherwise.
  if (direction === normalBalance) return amount;
  return -amount;
}
