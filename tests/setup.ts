/**
 * Test setup — runs before all tests.
 * Ensures the database is connected and test data exists.
 * Uses a global flag so setup runs once across all test files.
 *
 * Phase 12.4.6.3.2 — SAFETY:
 *   This module performs DB writes (createMany, create). It MUST only run
 *   against the isolated test database (DATABASE_TEST_URL). The guard in
 *   tests/env.ts enforces this — if DATABASE_TEST_URL is missing or equals
 *   DATABASE_URL, the test process exits before this code runs.
 *
 *   The legacy `deleteMany({})` calls in cleanupTestOrders have been replaced
 *   with scoped deletes (by id). NEVER use `deleteMany({})` — it destroys ALL
 *   data in the table, including production seed data.
 */

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/security";

const SETUP_KEY = "__roamlink_test_setup_done__";

export async function ensureTestSetup() {
  // Check if setup already ran in this process
  if ((globalThis as any)[SETUP_KEY]) return;
  (globalThis as any)[SETUP_KEY] = true;

  // Ensure pricing rules exist (don't re-sync plans — they're already seeded)
  const ruleCount = await db.pricingRule.count();
  if (ruleCount === 0) {
    await db.pricingRule.createMany({
      data: [
        { name: "Africa 35%", type: "percentage", value: 35, scope: "region", scopeValue: "Africa", priority: 10 },
        { name: "Europe 25%", type: "percentage", value: 25, scope: "region", scopeValue: "Europe", priority: 10 },
        { name: "Global 30%", type: "percentage", value: 30, scope: "global", priority: 1 },
      ],
    });
  }

  // Ensure test user exists
  const email = "test-user@roamlink.test";
  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    user = await db.user.create({
      data: {
        email,
        name: "Test User",
        passwordHash: await hashPassword("test12345"),
        role: "customer",
        emailVerified: new Date(),
      },
    });
  }
}

export const TEST_USER = { email: "test-user@roamlink.test", password: "test12345" };

/** Get a plan ID for testing (Ghana 10GB). */
export async function getTestPlanId(): Promise<string> {
  const plan = await db.plan.findFirst({
    where: { countryCode: "GH", dataAmount: 10240, status: "active" },
  });
  if (!plan) throw new Error("Test plan not found — run `bun run db:seed` first");
  return plan.id;
}

/**
 * Clean up test data after a test run.
 *
 * Phase 12.4.6.3.2 — SAFETY:
 *   This function deletes ONLY the rows whose IDs are passed in. NEVER use
 *   `deleteMany({})` (the legacy pattern) — it destroys ALL data in the table.
 *   Callers MUST pass the specific orderIds they created.
 *
 *   The scoped pattern below finds the child rows linked to the passed orderIds
 *   and deletes only those. If orderIds is empty, this function is a no-op
 *   (it does NOT delete all rows).
 */
export async function cleanupTestOrders(orderIds: string[]) {
  if (orderIds.length === 0) {
    // No-op — do NOT delete all rows. Legacy code used deleteMany({}) here,
    // which would destroy production data if run against DATABASE_URL.
    return;
  }

  // Delete child rows linked to the passed orderIds (scoped, not deleteMany({})).
  await db.installToken
    .deleteMany({ where: { orderId: { in: orderIds } } })
    .catch(() => {});
  await db.usage
    .deleteMany({ where: { orderId: { in: orderIds } } })
    .catch(() => {});
  await db.topUp
    .deleteMany({ where: { orderId: { in: orderIds } } })
    .catch(() => {});
  await db.esim
    .deleteMany({ where: { orderId: { in: orderIds } } })
    .catch(() => {});
  await db.payment
    .deleteMany({ where: { orderId: { in: orderIds } } })
    .catch(() => {});
  await db.order
    .deleteMany({ where: { id: { in: orderIds } } })
    .catch(() => {});
}
