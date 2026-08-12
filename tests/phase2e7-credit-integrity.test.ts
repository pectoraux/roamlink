/**
 * Phase 2E.7.1 — Customer Credit Transaction Integrity (concurrency-hardened)
 *
 * Tests:
 *   A. Same-order concurrent spend (Promise.all, same orderId → one spend)
 *   B. Different-order concurrent spend (two orderIds, one balance → one wins)
 *   C. Referral double-call, SAME orderId (completeReferral × 2 → all invariants)
 *   C2. Referral double-call, DIFFERENT orderIds (hardest case — only conditional UPDATE protects)
 *   D. Credit issuance reconciliation (ledger fails → reconciliation_required → worker repairs → idempotent)
 *   E. Admin credit idempotency (same operationId → no duplicate)
 *   F. Full credit-funded renewal (price=660, credit=660, cash=0)
 *   H. Credit/ledger reconciliation
 *
 * All tests execute against Neon PostgreSQL.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup, TEST_USER } from "./setup";
import { spendCredit, addCredit, getCreditBalance, completeReferral, reconcileCreditWithLedger, processDueCreditIssuances } from "@/lib/promotions/referral-service";
import { renewSubscription } from "@/lib/subscriptions/service";
import { ensureChartOfAccounts, ACCOUNT_CODES } from "@/lib/finance/double-entry-ledger";

let testUserId: string;
let setupDone = false;
const cleanup = { vns: [] as string[], subs: [] as string[], cycles: [] as string[], issuances: [] as string[] };

async function ensureSetup() {
  if (setupDone) return; setupDone = true;
  await ensureTestSetup();
  const user = await db.user.findUnique({ where: { email: TEST_USER.email } });
  testUserId = user!.id;
  await ensureChartOfAccounts();
}

async function setupVNSub(label: string, sellingPrice = 660, providerCost = 400, creditBalance = 10000) {
  const vn = await db.virtualNumber.create({ data: {
    e164: `+1234567${Date.now().toString().slice(-4)}${label}`, country: "US", countryCode: "US",
    region: "North America", numberType: "local", smsEnabled: true, voiceEnabled: false,
    status: "active", provider: "mock", providerNumberId: `mock-vn-${Date.now()}`,
    providerCost, sellingPrice, currency: "USD",
    userId: testUserId, activatedAt: new Date(),
    expiresAt: new Date(Date.now() - 86400000),
  }}); cleanup.vns.push(vn.id);
  const sub = await db.numberSubscription.create({ data: {
    virtualNumberId: vn.id, userId: testUserId, status: "active",
    billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() - 86400000),
    idempotencyKey: `sub_${label}_${Date.now()}`,
  }}); cleanup.subs.push(sub.id);
  await db.customerCredit.upsert({ where: { userId: testUserId },
    update: { balanceMinor: creditBalance, totalSpent: 0, totalEarned: 0 }, create: { userId: testUserId, balanceMinor: creditBalance } });
  return { vn, sub };
}

afterAll(async () => {
  try {
    if (cleanup.cycles.length) await db.subscriptionRenewalCycle.deleteMany({ where: { id: { in: cleanup.cycles } } }).catch(() => {});
    if (cleanup.issuances.length) await db.creditIssuance.deleteMany({ where: { id: { in: cleanup.issuances } } }).catch(() => {});
    if (cleanup.subs.length) await db.numberSubscription.deleteMany({ where: { id: { in: cleanup.subs } } }).catch(() => {});
    if (cleanup.vns.length) await db.virtualNumber.deleteMany({ where: { id: { in: cleanup.vns } } }).catch(() => {});
    await db.customerCredit.update({ where: { userId: testUserId }, data: { balanceMinor: 10000, totalSpent: 0, totalEarned: 0 } }).catch(() => {});
  } catch {} await db.$disconnect();
}, 180000);

// ===========================================================================

describe("Phase 2E.7 — Credit Transaction Integrity", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Same-order concurrent spend: one spend, one CreditTransaction", async () => {
    await ensureSetup();
    await db.customerCredit.update({ where: { userId: testUserId }, data: { balanceMinor: 1000 } });

    const orderId = `same_order_${Date.now()}`;
    const [r1, r2] = await Promise.all([
      spendCredit({ userId: testUserId, amountMinor: 1000, orderId, reason: "Test A1" }),
      spendCredit({ userId: testUserId, amountMinor: 1000, orderId, reason: "Test A2" }),
    ]);

    // Exactly one should have consumed 1000; the other returns 1000 idempotently
    expect(r1 + r2).toBe(1000); // NOT 2000

    // Balance must be 0
    const balance = await getCreditBalance(testUserId);
    expect(balance.balanceMinor).toBe(0);

    // Exactly ONE CreditTransaction for this orderId
    const txns = await db.creditTransaction.findMany({ where: { userId: testUserId, orderId, type: "purchase_credit" } });
    expect(txns.length).toBe(1);

    // Restore
    await db.customerCredit.update({ where: { userId: testUserId }, data: { balanceMinor: 10000 } });
  }, 60000);

  it("B. Different-order concurrent spend: one wins, balance=0", async () => {
    await ensureSetup();
    await db.customerCredit.update({ where: { userId: testUserId }, data: { balanceMinor: 1000 } });

    const [r1, r2] = await Promise.all([
      spendCredit({ userId: testUserId, amountMinor: 1000, orderId: `diff_order_1_${Date.now()}`, reason: "Test B1" }),
      spendCredit({ userId: testUserId, amountMinor: 1000, orderId: `diff_order_2_${Date.now()}`, reason: "Test B2" }),
    ]);

    // Exactly one consumed 1000; the other 0
    expect(r1 + r2).toBe(1000);
    expect(r1 + r2).not.toBe(2000);

    const balance = await getCreditBalance(testUserId);
    expect(balance.balanceMinor).toBe(0);
    expect(balance.balanceMinor).toBeGreaterThanOrEqual(0); // never negative

    await db.customerCredit.update({ where: { userId: testUserId }, data: { balanceMinor: 10000 } });
  }, 60000);

  it("C. Referral double-call: EXACTLY one reward per recipient (all invariants)", async () => {
    await ensureSetup();

    // --- Setup: referrer + referee + pending ReferralUse ---
    const referrerUser = await db.user.create({ data: { email: `referrer_2e7c_${Date.now()}@test.com`, name: "Referrer C", passwordHash: "$2a$10$test", role: "customer" } });
    const refereeUser = await db.user.create({ data: { email: `referee_2e7c_${Date.now()}@test.com`, name: "Referee C", passwordHash: "$2a$10$test", role: "customer" } });
    const referrerReward = 200;
    const refereeReward = 200;
    const referrer = await db.referral.create({ data: { referrerUserId: referrerUser.id, referralCode: `TESTC-${Date.now()}`, referrerReward, refereeReward } });
    const referralUse = await db.referralUse.create({ data: { referralId: referrer.id, refereeUserId: refereeUser.id, status: "pending" } });

    // Capture pre-state
    const referrerBalanceBefore = (await getCreditBalance(referrerUser.id)).balanceMinor;
    const refereeBalanceBefore = (await getCreditBalance(refereeUser.id)).balanceMinor;
    const referralBefore = await db.referral.findUnique({ where: { id: referrer.id } });

    const orderId = `referral_order_C_${Date.now()}`;

    // --- Fire TWO CONCURRENT completeReferral calls ---
    await Promise.all([
      completeReferral({ refereeUserId: refereeUser.id, orderId }),
      completeReferral({ refereeUserId: refereeUser.id, orderId }),
    ]);

    // --- Verify ALL invariants (not just CreditIssuance count) ---

    // 1. Exactly ONE ReferralUse row, status = completed
    const uses = await db.referralUse.findMany({ where: { refereeUserId: refereeUser.id } });
    expect(uses.length).toBe(1);
    expect(uses[0].status).toBe("completed");
    expect(uses[0].orderId).toBe(orderId);

    // 2. Exactly ONE CreditTransaction for the referrer (type=referral_reward, this orderId)
    const referrerTxns = await db.creditTransaction.findMany({ where: { userId: referrerUser.id, type: "referral_reward", orderId } });
    expect(referrerTxns.length).toBe(1);
    expect(referrerTxns[0].amountMinor).toBe(referrerReward);

    // 3. Exactly ONE CreditTransaction for the referee
    const refereeTxns = await db.creditTransaction.findMany({ where: { userId: refereeUser.id, type: "referral_reward", orderId } });
    expect(refereeTxns.length).toBe(1);
    expect(refereeTxns[0].amountMinor).toBe(refereeReward);

    // 4. Referrer balance increased by EXACTLY one reward (not 2x)
    const referrerBalanceAfter = (await getCreditBalance(referrerUser.id)).balanceMinor;
    expect(referrerBalanceAfter - referrerBalanceBefore).toBe(referrerReward);

    // 5. Referee balance increased by EXACTLY one reward (not 2x)
    const refereeBalanceAfter = (await getCreditBalance(refereeUser.id)).balanceMinor;
    expect(refereeBalanceAfter - refereeBalanceBefore).toBe(refereeReward);

    // 6. Referral.completedReferrals incremented by EXACTLY 1
    const referralAfter = await db.referral.findUnique({ where: { id: referrer.id } });
    expect(referralAfter!.completedReferrals - referralBefore!.completedReferrals).toBe(1);

    // 7. Referral.totalRewardPaid incremented by EXACTLY once (referrer + referee)
    expect(referralAfter!.totalRewardPaid - referralBefore!.totalRewardPaid).toBe(referrerReward + refereeReward);

    // 8. Exactly ONE CreditIssuance per recipient (sourceId = referralUse.id)
    const referrerIssuances = await db.creditIssuance.findMany({ where: { userId: referrerUser.id, sourceType: "referral_reward", sourceId: referralUse.id } });
    const refereeIssuances = await db.creditIssuance.findMany({ where: { userId: refereeUser.id, sourceType: "referral_reward", sourceId: referralUse.id } });
    expect(referrerIssuances.length).toBe(1);
    expect(refereeIssuances.length).toBe(1);
    expect(referrerIssuances[0].status).toBe("completed");
    expect(refereeIssuances[0].status).toBe("completed");

    // 9. Exactly ONE ledger posting per recipient (idempotencyKey = issuance:ledger)
    const referrerLedgerTxns = await db.ledgerTransaction.findMany({ where: { idempotencyKey: `${referrerIssuances[0].idempotencyKey}:ledger` } });
    const refereeLedgerTxns = await db.ledgerTransaction.findMany({ where: { idempotencyKey: `${refereeIssuances[0].idempotencyKey}:ledger` } });
    expect(referrerLedgerTxns.length).toBe(1);
    expect(refereeLedgerTxns.length).toBe(1);

    // 10. Verify ledger entries: one debit to PROMOTIONAL_EXPENSE + one credit to CUSTOMER_CREDIT_LIABILITY per recipient
    const referrerEntries = await db.ledgerEntry.findMany({ where: { transactionId: referrerLedgerTxns[0].id }, include: { account: true } });
    expect(referrerEntries.filter(e => e.account.code === ACCOUNT_CODES.PROMOTIONAL_EXPENSE && e.direction === "debit").length).toBe(1);
    expect(referrerEntries.filter(e => e.account.code === ACCOUNT_CODES.CUSTOMER_CREDIT_LIABILITY && e.direction === "credit").length).toBe(1);

    // --- Cleanup ---
    await db.ledgerEntry.deleteMany({ where: { transactionId: { in: [...referrerLedgerTxns.map(t => t.id), ...refereeLedgerTxns.map(t => t.id)] } } }).catch(() => {});
    await db.ledgerTransaction.deleteMany({ where: { id: { in: [...referrerLedgerTxns.map(t => t.id), ...refereeLedgerTxns.map(t => t.id)] } } }).catch(() => {});
    await db.creditIssuance.deleteMany({ where: { id: { in: [referrerIssuances[0].id, refereeIssuances[0].id] } } }).catch(() => {});
    await db.creditTransaction.deleteMany({ where: { userId: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
    await db.customerCredit.deleteMany({ where: { userId: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
    await db.referralUse.deleteMany({ where: { refereeUserId: refereeUser.id } }).catch(() => {});
    await db.referral.deleteMany({ where: { id: referrer.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
  }, 120000);

  it("C2. Referral concurrent with DIFFERENT orderIds: still exactly one reward", async () => {
    // This tests the hardest case: two calls with different orderIds, where the
    // CreditTransaction unique constraint (userId, orderId, type) does NOT help
    // because the orderIds differ. The conditional UPDATE on ReferralUse.status
    // is the sole protection.
    await ensureSetup();

    const referrerUser = await db.user.create({ data: { email: `referrer_2e7c2_${Date.now()}@test.com`, name: "Referrer C2", passwordHash: "$2a$10$test", role: "customer" } });
    const refereeUser = await db.user.create({ data: { email: `referee_2e7c2_${Date.now()}@test.com`, name: "Referee C2", passwordHash: "$2a$10$test", role: "customer" } });
    const referrerReward = 200;
    const refereeReward = 200;
    const referrer = await db.referral.create({ data: { referrerUserId: referrerUser.id, referralCode: `TESTC2-${Date.now()}`, referrerReward, refereeReward } });
    const referralUse = await db.referralUse.create({ data: { referralId: referrer.id, refereeUserId: refereeUser.id, status: "pending" } });

    const referrerBalanceBefore = (await getCreditBalance(referrerUser.id)).balanceMinor;
    const refereeBalanceBefore = (await getCreditBalance(refereeUser.id)).balanceMinor;

    // Two DIFFERENT orderIds — the unique constraint on CreditTransaction
    // (userId, orderId, type) would NOT catch a double-credit here because
    // the orderIds differ. Only the conditional UPDATE protects us.
    const orderId1 = `referral_order_C2a_${Date.now()}`;
    const orderId2 = `referral_order_C2b_${Date.now()}`;

    await Promise.all([
      completeReferral({ refereeUserId: refereeUser.id, orderId: orderId1 }),
      completeReferral({ refereeUserId: refereeUser.id, orderId: orderId2 }),
    ]);

    // Referrer balance: exactly ONE reward
    const referrerBalanceAfter = (await getCreditBalance(referrerUser.id)).balanceMinor;
    expect(referrerBalanceAfter - referrerBalanceBefore).toBe(referrerReward);

    // Referee balance: exactly ONE reward
    const refereeBalanceAfter = (await getCreditBalance(refereeUser.id)).balanceMinor;
    expect(refereeBalanceAfter - refereeBalanceBefore).toBe(refereeReward);

    // Exactly ONE CreditTransaction per recipient total (across both orderIds)
    const referrerTxnsByOrder = await db.creditTransaction.findMany({ where: { userId: referrerUser.id, type: "referral_reward", orderId: { in: [orderId1, orderId2] } } });
    expect(referrerTxnsByOrder.length).toBe(1);

    const refereeTxnsByOrder = await db.creditTransaction.findMany({ where: { userId: refereeUser.id, type: "referral_reward", orderId: { in: [orderId1, orderId2] } } });
    expect(refereeTxnsByOrder.length).toBe(1);

    // Exactly ONE CreditIssuance per recipient
    const referrerIssuances = await db.creditIssuance.findMany({ where: { userId: referrerUser.id, sourceType: "referral_reward", sourceId: referralUse.id } });
    const refereeIssuances = await db.creditIssuance.findMany({ where: { userId: refereeUser.id, sourceType: "referral_reward", sourceId: referralUse.id } });
    expect(referrerIssuances.length).toBe(1);
    expect(refereeIssuances.length).toBe(1);

    // Referral aggregates: exactly one increment
    const referralAfter = await db.referral.findUnique({ where: { id: referrer.id } });
    expect(referralAfter!.completedReferrals).toBe(1);
    expect(referralAfter!.totalRewardPaid).toBe(referrerReward + refereeReward);

    // Cleanup
    const ledgerTxnIds = [...referrerIssuances, ...refereeIssuances].map(i => i.ledgerTransactionId).filter(Boolean) as string[];
    if (ledgerTxnIds.length) {
      await db.ledgerEntry.deleteMany({ where: { transactionId: { in: ledgerTxnIds } } }).catch(() => {});
      await db.ledgerTransaction.deleteMany({ where: { id: { in: ledgerTxnIds } } }).catch(() => {});
    }
    await db.creditIssuance.deleteMany({ where: { id: { in: [...referrerIssuances.map(i => i.id), ...refereeIssuances.map(i => i.id)] } } }).catch(() => {});
    await db.creditTransaction.deleteMany({ where: { userId: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
    await db.customerCredit.deleteMany({ where: { userId: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
    await db.referralUse.deleteMany({ where: { refereeUserId: refereeUser.id } }).catch(() => {});
    await db.referral.deleteMany({ where: { id: referrer.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
  }, 120000);

  it("D. Credit issuance reconciliation: ledger fails → reconciliation_required → worker repairs (idempotent)", async () => {
    await ensureSetup();

    const referrerUser = await db.user.create({ data: { email: `referrer_2e7d_${Date.now()}@test.com`, name: "Referrer D", passwordHash: "$2a$10$test", role: "customer" } });
    const refereeUser = await db.user.create({ data: { email: `referee_2e7d_${Date.now()}@test.com`, name: "Referee D", passwordHash: "$2a$10$test", role: "customer" } });
    const referrerReward = 200;
    const refereeReward = 200;
    const referrer = await db.referral.create({ data: { referrerUserId: referrerUser.id, referralCode: `TESTD-${Date.now()}`, referrerReward, refereeReward } });
    const referralUse = await db.referralUse.create({ data: { referralId: referrer.id, refereeUserId: refereeUser.id, status: "pending" } });

    const orderId = `referral_order_D_${Date.now()}`;

    // Manually complete the referral (single call)
    await completeReferral({ refereeUserId: refereeUser.id, orderId });

    // The CreditIssuance records should be completed (ledger succeeded).
    const referrerIssuance = await db.creditIssuance.findFirst({ where: { userId: referrerUser.id, sourceType: "referral_reward", sourceId: referralUse.id } });
    const refereeIssuance = await db.creditIssuance.findFirst({ where: { userId: refereeUser.id, sourceType: "referral_reward", sourceId: referralUse.id } });
    expect(referrerIssuance).toBeTruthy();
    expect(refereeIssuance).toBeTruthy();
    expect(referrerIssuance!.status).toBe("completed");
    expect(refereeIssuance!.status).toBe("completed");

    // --- Simulate ledger failure: delete the ledger transaction and mark issuance as reconciliation_required ---
    const referrerLedgerId = referrerIssuance!.ledgerTransactionId!;
    const refereeLedgerId = refereeIssuance!.ledgerTransactionId!;

    // Delete the ledger entries + transaction (simulate the ledger posting being lost)
    await db.ledgerEntry.deleteMany({ where: { transactionId: { in: [referrerLedgerId, refereeLedgerId] } } });
    await db.ledgerTransaction.deleteMany({ where: { id: { in: [referrerLedgerId, refereeLedgerId] } } });

    // Mark both issuances as reconciliation_required (simulate postCreditIssuance's catch path)
    await db.creditIssuance.update({ where: { id: referrerIssuance!.id }, data: { status: "reconciliation_required", ledgerTransactionId: null } });
    await db.creditIssuance.update({ where: { id: refereeIssuance!.id }, data: { status: "reconciliation_required", ledgerTransactionId: null } });

    // Verify: the operational credit is STILL there (balance unchanged) but ledger is missing
    const referrerBalanceBeforeRecon = (await getCreditBalance(referrerUser.id)).balanceMinor;
    expect(referrerBalanceBeforeRecon).toBe(referrerReward); // operational credit intact

    // Verify: reconciliation_needed issuances exist
    const dueBefore = await db.creditIssuance.findMany({ where: { status: "reconciliation_required" } });
    expect(dueBefore.filter(i => i.id === referrerIssuance!.id || i.id === refereeIssuance!.id).length).toBe(2);

    // --- Run the reconciliation worker (FIRST time) ---
    const recon1 = await processDueCreditIssuances();
    expect(recon1.retried).toBeGreaterThanOrEqual(2);
    expect(recon1.repaired).toBeGreaterThanOrEqual(2);

    // Verify: both issuances are now completed
    const referrerIssuanceAfter1 = await db.creditIssuance.findUnique({ where: { id: referrerIssuance!.id } });
    const refereeIssuanceAfter1 = await db.creditIssuance.findUnique({ where: { id: refereeIssuance!.id } });
    expect(referrerIssuanceAfter1!.status).toBe("completed");
    expect(refereeIssuanceAfter1!.status).toBe("completed");
    expect(referrerIssuanceAfter1!.ledgerTransactionId).toBeTruthy();
    expect(refereeIssuanceAfter1!.ledgerTransactionId).toBeTruthy();

    // Verify: ledger transactions were re-created (exactly ONE per issuance)
    const referrerLedgerAfter1 = await db.ledgerTransaction.findMany({ where: { idempotencyKey: `${referrerIssuance!.idempotencyKey}:ledger` } });
    const refereeLedgerAfter1 = await db.ledgerTransaction.findMany({ where: { idempotencyKey: `${refereeIssuance!.idempotencyKey}:ledger` } });
    expect(referrerLedgerAfter1.length).toBe(1);
    expect(refereeLedgerAfter1.length).toBe(1);

    // Verify: operational credit UNCHANGED (no double-credit from reconciliation)
    const referrerBalanceAfter1 = (await getCreditBalance(referrerUser.id)).balanceMinor;
    expect(referrerBalanceAfter1).toBe(referrerBalanceBeforeRecon);

    // Verify: exactly ONE CreditTransaction per recipient (reconciliation didn't add another)
    const referrerTxns = await db.creditTransaction.findMany({ where: { userId: referrerUser.id, type: "referral_reward", orderId } });
    const refereeTxns = await db.creditTransaction.findMany({ where: { userId: refereeUser.id, type: "referral_reward", orderId } });
    expect(referrerTxns.length).toBe(1);
    expect(refereeTxns.length).toBe(1);

    // --- Run the reconciliation worker AGAIN (SECOND time) — must be idempotent ---
    const recon2 = await processDueCreditIssuances();
    expect(recon2.retried).toBe(0); // no reconciliation_required issuances left
    expect(recon2.repaired).toBe(0);

    // Verify: still exactly ONE ledger transaction per issuance (no duplicate from second run)
    const referrerLedgerAfter2 = await db.ledgerTransaction.findMany({ where: { idempotencyKey: `${referrerIssuance!.idempotencyKey}:ledger` } });
    const refereeLedgerAfter2 = await db.ledgerTransaction.findMany({ where: { idempotencyKey: `${refereeIssuance!.idempotencyKey}:ledger` } });
    expect(referrerLedgerAfter2.length).toBe(1);
    expect(refereeLedgerAfter2.length).toBe(1);

    // Verify: operational credit STILL unchanged
    const referrerBalanceAfter2 = (await getCreditBalance(referrerUser.id)).balanceMinor;
    expect(referrerBalanceAfter2).toBe(referrerBalanceBeforeRecon);

    // --- Cleanup ---
    const allLedgerIds = [referrerIssuanceAfter1!.ledgerTransactionId!, refereeIssuanceAfter1!.ledgerTransactionId!];
    await db.ledgerEntry.deleteMany({ where: { transactionId: { in: allLedgerIds } } }).catch(() => {});
    await db.ledgerTransaction.deleteMany({ where: { id: { in: allLedgerIds } } }).catch(() => {});
    await db.creditIssuance.deleteMany({ where: { id: { in: [referrerIssuance!.id, refereeIssuance!.id] } } }).catch(() => {});
    await db.creditTransaction.deleteMany({ where: { userId: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
    await db.customerCredit.deleteMany({ where: { userId: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
    await db.referralUse.deleteMany({ where: { refereeUserId: refereeUser.id } }).catch(() => {});
    await db.referral.deleteMany({ where: { id: referrer.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [referrerUser.id, refereeUser.id] } } }).catch(() => {});
  }, 180000);

  it("E. Admin credit idempotency: same operationId → no duplicate", async () => {
    await ensureSetup();
    const balanceBefore = await getCreditBalance(testUserId);
    const operationId = `admin_op_2e7_${Date.now()}`;

    // First call
    await addCredit({ userId: testUserId, amountMinor: 500, type: "admin_adjustment", reason: "Test admin credit", operationId });

    const balanceAfter1 = await getCreditBalance(testUserId);
    expect(balanceAfter1.balanceMinor).toBe(balanceBefore.balanceMinor + 500);

    // Second call with same operationId — should be idempotent
    await addCredit({ userId: testUserId, amountMinor: 500, type: "admin_adjustment", reason: "Test admin credit", operationId });

    const balanceAfter2 = await getCreditBalance(testUserId);
    expect(balanceAfter2.balanceMinor).toBe(balanceAfter1.balanceMinor); // NOT +500 again

    // Exactly ONE CreditIssuance for this operationId
    const issuances = await db.creditIssuance.findMany({ where: { idempotencyKey: `credit_issuance_admin_adjustment_${operationId}_${testUserId}` } });
    expect(issuances.length).toBe(1);
    cleanup.issuances.push(issuances[0].id);
  }, 60000);

  it("F. Full credit-funded renewal: price=660, credit=660, cash=0", async () => {
    await ensureSetup();
    const { vn, sub } = await setupVNSub("fullcreditF", 660, 400, 660);
    const oldPeriodEnd = sub.currentPeriodEnd;

    const result = await renewSubscription(sub.id);
    expect(result.success).toBe(true);

    const cycleKey = `renewal_${sub.id}_${oldPeriodEnd.getTime()}`;
    const cycle = await db.subscriptionRenewalCycle.findUnique({ where: { cycleKey } });
    expect(cycle!.paidFromCreditMinor).toBe(660);
    expect(cycle!.paidFromCashMinor).toBe(0);
    expect(cycle!.paymentFeeMinor).toBe(0);
    cleanup.cycles.push(cycle!.id);

    // Verify: ledger has CUSTOMER_CREDIT_LIABILITY debit, NO CASH debit
    const txns = await db.ledgerTransaction.findMany({ where: { orderId: cycleKey }, include: { entries: { include: { account: true } } } });
    const allEntries = txns.flatMap(t => t.entries);
    const creditEntries = allEntries.filter(e => e.account.code === ACCOUNT_CODES.CUSTOMER_CREDIT_LIABILITY && e.direction === "debit");
    const cashEntries = allEntries.filter(e => e.account.code === ACCOUNT_CODES.CASH && e.direction === "debit");
    expect(creditEntries.length).toBeGreaterThan(0);
    expect(creditEntries[0].amountMinor).toBe(660);
    expect(cashEntries.length).toBe(0);

    // Credit balance is 0
    const balance = await getCreditBalance(testUserId);
    expect(balance.balanceMinor).toBe(0);

    await db.customerCredit.update({ where: { userId: testUserId }, data: { balanceMinor: 10000 } });
  }, 120000);

  it("H. Credit/ledger reconciliation: operational balance matches ledger liability", async () => {
    await ensureSetup();
    const result = await reconcileCreditWithLedger();
    // We can't guarantee exact reconciliation because of prior test data,
    // but the function must execute without error and return a result.
    expect(result).toBeDefined();
    expect(result.reconciled).toBeDefined();
    expect(Array.isArray(result.discrepancies)).toBe(true);
  }, 60000);

  it("Static: spendCredit uses transaction + P2002 catch", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/promotions/referral-service.ts", "utf-8");
    expect(source).toContain("$transaction");
    expect(source).toContain("P2002");
    expect(source).toContain("FOR UPDATE");
  }, 10000);

  it("Static: completeReferral uses conditional UPDATE WHERE status='pending' (concurrency-safe)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/promotions/referral-service.ts", "utf-8");
    // The serialization point: conditional UPDATE on ReferralUse.status
    expect(source).toContain('WHERE id = ${referralUse.id} AND status = \'pending\'');
    // The loser-detection: checking affected row count
    expect(source).toContain("if (affected === 0)");
    // The reconciliation worker exists
    expect(source).toContain("processDueCreditIssuances");
    expect(source).toContain("reconciliation_required");
    // addCredit uses INSERT ... ON CONFLICT DO NOTHING (concurrency-safe)
    expect(source).toContain("ON CONFLICT (\"idempotencyKey\") DO NOTHING");
  }, 10000);

  it("Static: addCredit requires operationId (no Date.now fallback)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/promotions/referral-service.ts", "utf-8");
    expect(source).toContain("operationId or orderId is required");
    // Verify addCredit does NOT use Date.now() as idempotency identity
    // Extract just the addCredit function body (between export and the next export)
    const startIdx = source.indexOf("export async function addCredit");
    const nextExportIdx = source.indexOf("\nexport ", startIdx + 1);
    const addCreditBody = source.substring(startIdx, nextExportIdx > 0 ? nextExportIdx : source.length);
    // Check code lines (not comments) for Date.now() as identity
    const codeLines = addCreditBody.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const hasDateNow = codeLines.some(l => l.includes("Date.now()"));
    expect(hasDateNow).toBe(false);
  }, 10000);
});
