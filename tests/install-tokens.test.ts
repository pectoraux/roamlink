/**
 * Installation token security tests.
 * Verifies tokens are: short-lived, single-use, user-scoped.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { createOrder, initiatePayment, confirmAndProvision } from "@/lib/orders/service";
import { mockPaymentProvider } from "@/lib/payments";
import { createInstallToken, consumeInstallToken } from "@/lib/esim/install-tokens";
import { expectReject } from "./helpers";
import { ensureTestSetup, getTestPlanId, TEST_USER, cleanupTestOrders } from "./setup";
import { AppError } from "@/lib/errors";

let testUserId: string;
let planId: string;
let esimId: string | null = null;
const createdOrderIds: string[] = [];

/** Lazy setup — runs once on first test, avoids beforeAll 5s timeout limit. */
async function ensureEsimSetup() {
  if (esimId) return;
  await ensureTestSetup();
  const user = await db.user.findUnique({ where: { email: TEST_USER.email } });
  testUserId = user!.id;
  planId = await getTestPlanId();

  // Create an eSIM to test tokens against
  const order = await createOrder({
    userId: testUserId,
    planId,
    idempotencyKey: `test_token_setup_${Date.now()}`,
  });
  createdOrderIds.push(order.id);
  const payment = await initiatePayment({
    orderId: order.id,
    userId: testUserId,
    idempotencyKey: `test_token_pay_${order.id}`,
  });
  mockPaymentProvider.confirmIntent(payment.paymentReference);
  const result = await confirmAndProvision({
    orderId: order.id,
    userId: testUserId,
    idempotencyKey: `test_token_confirm_${order.id}`,
  });
  esimId = result.esimId!;
}

afterAll(async () => {
  await cleanupTestOrders(createdOrderIds);
  await db.$disconnect();
});

describe("installation tokens", () => {
  it("creates a token with 15-minute expiry", async () => {
    await ensureEsimSetup();
    const { token, expiresAt } = await createInstallToken(testUserId, esimId!);
    expect(token).toBeTruthy();
    expect(token.length).toBe(64); // 32 bytes hex

    const expiry = new Date(expiresAt);
    const now = new Date();
    const diffMs = expiry.getTime() - now.getTime();
    const diffMin = diffMs / (1000 * 60);

    // Should expire in ~15 minutes (allow 1 min tolerance)
    expect(diffMin).toBeGreaterThan(13);
    expect(diffMin).toBeLessThanOrEqual(15);
  }, 60000);

  it("consumes a valid token and returns activation details", async () => {
    await ensureEsimSetup();
    const { token } = await createInstallToken(testUserId, esimId!);
    const result = await consumeInstallToken(testUserId, token);

    expect(result.esimId).toBe(esimId);
    expect(result.iccid).toMatch(/^\d{19,20}$/);
    expect(result.smdpAddress).toBeTruthy();
    expect(result.activationCode).toBeTruthy();
    expect(result.qrCode).toContain("data:image/png");
  }, 60000);

  it("rejects token replay (single-use)", async () => {
    await ensureEsimSetup();
    const { token } = await createInstallToken(testUserId, esimId!);

    // First use — succeeds
    await consumeInstallToken(testUserId, token);

    // Second use — should fail
    await expectReject(() => consumeInstallToken(testUserId, token), AppError);
  }, 60000);

  it("rejects token from a different user", async () => {
    await ensureEsimSetup();
    const { token } = await createInstallToken(testUserId, esimId!);

    // Create another user
    const otherUser = await db.user.create({
      data: {
        email: `token-thief-${Date.now()}@roamlink.test`,
        name: "Token Thief",
        passwordHash: await import("@/lib/security").then(m => m.hashPassword("test12345")),
        role: "customer",
      },
    });

    // Other user tries to consume the token
    await expectReject(() => consumeInstallToken(otherUser.id, token), AppError);

    await db.user.delete({ where: { id: otherUser.id } });
  }, 60000);

  it("rejects expired tokens", async () => {
    await ensureEsimSetup();
    // Create a token and manually expire it
    const { token } = await createInstallToken(testUserId, esimId!);
    await db.installToken.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() - 1000) }, // expired 1 second ago
    });

    await expectReject(() => consumeInstallToken(testUserId, token), AppError);
  }, 60000);

  it("rejects invalid token", async () => {
    await ensureEsimSetup();
    await expectReject(() => consumeInstallToken(testUserId, "invalid-token-12345"), AppError);
  }, 60000);

  it("rejects token for an eSIM the user doesn't own", async () => {
    await ensureEsimSetup();
    // Create another user + their eSIM
    const otherUser = await db.user.create({
      data: {
        email: `esim-owner-${Date.now()}@roamlink.test`,
        name: "eSIM Owner",
        passwordHash: await import("@/lib/security").then(m => m.hashPassword("test12345")),
        role: "customer",
      },
    });

    const otherOrder = await createOrder({
      userId: otherUser.id,
      planId,
      idempotencyKey: `test_token_other_${Date.now()}`,
    });
    const otherPayment = await initiatePayment({
      orderId: otherOrder.id,
      userId: otherUser.id,
      idempotencyKey: `test_token_other_pay_${otherOrder.id}`,
    });
    mockPaymentProvider.confirmIntent(otherPayment.paymentReference);
    const otherResult = await confirmAndProvision({
      orderId: otherOrder.id,
      userId: otherUser.id,
      idempotencyKey: `test_token_other_confirm_${otherOrder.id}`,
    });

    // testUserId tries to create a token for otherUser's eSIM
    await expectReject(() => createInstallToken(testUserId, otherResult.esimId!), AppError);

    await cleanupTestOrders([otherOrder.id]);
    await db.user.delete({ where: { id: otherUser.id } });
  }, 60000);
});
