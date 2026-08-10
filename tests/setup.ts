/**
 * Test setup — runs before all tests.
 * Ensures the database is connected and test data exists.
 * Uses a global flag so setup runs once across all test files.
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

/** Clean up test data after a test run. */
export async function cleanupTestOrders(orderIds: string[]) {
  // Delete in dependency order to respect foreign keys
  await db.installToken.deleteMany({}).catch(() => {});
  await db.usage.deleteMany({}).catch(() => {});
  await db.topUp.deleteMany({}).catch(() => {});
  await db.esim.deleteMany({}).catch(() => {});
  await db.payment.deleteMany({}).catch(() => {});
  if (orderIds.length > 0) {
    await db.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
  }
}
