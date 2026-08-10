/**
 * Integration tests — purchase & provisioning lifecycle.
 * Tests the actual order service + payment + provisioning against the real DB.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { createOrder, initiatePayment, confirmAndProvision, provisionOrderESIM, getOrder } from "@/lib/orders/service";
import { mockPaymentProvider } from "@/lib/payments";
import { expectReject } from "./helpers";
import { ensureTestSetup, getTestPlanId, TEST_USER, cleanupTestOrders } from "./setup";

let testUserId: string;
let planId: string;
const createdOrderIds: string[] = [];

beforeAll(async () => {
  await ensureTestSetup();
  const user = await db.user.findUnique({ where: { email: TEST_USER.email } });
  testUserId = user!.id;
  planId = await getTestPlanId();
});

afterAll(async () => {
  await cleanupTestOrders(createdOrderIds);
  await db.$disconnect();
});

describe("purchase → provisioning lifecycle", () => {
  it("completes the full flow: order → payment → provisioning", async () => {
    // 1. Create order
    const order = await createOrder({
      userId: testUserId,
      planId,
      idempotencyKey: `test_lifecycle_${Date.now()}`,
    });
    createdOrderIds.push(order.id);
    expect(order.status).toBe("CHECKOUT_CREATED");
    expect(order.amountMinor).toBeGreaterThan(0);

    // 2. Initiate payment
    const payment = await initiatePayment({
      orderId: order.id,
      userId: testUserId,
      idempotencyKey: `test_pay_${order.id}`,
    });
    expect(payment.paymentReference).toBeTruthy();
    expect(payment.status).toBe("PAYMENT_PENDING");

    // 3. Confirm + provision
    mockPaymentProvider.confirmIntent(payment.paymentReference);
    const result = await confirmAndProvision({
      orderId: order.id,
      userId: testUserId,
      idempotencyKey: `test_confirm_${order.id}`,
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.esimId).toBeTruthy();
    expect(result.paymentStatus).toBe("succeeded");
  }, 60000);

  it("stores real provisioning data (ICCID, SM-DP+, activation code)", async () => {
    const order = await createOrder({
      userId: testUserId,
      planId,
      idempotencyKey: `test_prov_data_${Date.now()}`,
    });
    createdOrderIds.push(order.id);

    const payment = await initiatePayment({
      orderId: order.id,
      userId: testUserId,
      idempotencyKey: `test_pay2_${order.id}`,
    });

    mockPaymentProvider.confirmIntent(payment.paymentReference);
    const result = await confirmAndProvision({
      orderId: order.id,
      userId: testUserId,
      idempotencyKey: `test_confirm2_${order.id}`,
    });

    const esim = await db.esim.findUnique({ where: { id: result.esimId! } });
    expect(esim).toBeTruthy();
    expect(esim!.iccid).toMatch(/^\d{19,20}$/); // ICCID is 19-20 digits
    expect(esim!.smdpAddress).toBeTruthy();
    expect(esim!.activationCode).toBeTruthy();
    expect(esim!.qrCode).toContain("data:image/png"); // QR is a data URL
    expect(esim!.status).toBe("active");
    expect(esim!.dataRemaining).toBe(esim!.dataAmount); // full allowance at start
  }, 60000);
});

describe("idempotency", () => {
  it("duplicate order creation returns the same order", async () => {
    const idemKey = `test_idem_order_${Date.now()}`;
    const order1 = await createOrder({ userId: testUserId, planId, idempotencyKey: idemKey });
    const order2 = await createOrder({ userId: testUserId, planId, idempotencyKey: idemKey });
    createdOrderIds.push(order1.id);

    expect(order1.id).toBe(order2.id);
  }, 60000);

  it("duplicate confirm does not create a second eSIM", async () => {
    const order = await createOrder({
      userId: testUserId,
      planId,
      idempotencyKey: `test_idem_prov_${Date.now()}`,
    });
    createdOrderIds.push(order.id);

    const payment = await initiatePayment({
      orderId: order.id,
      userId: testUserId,
      idempotencyKey: `test_idem_pay_${order.id}`,
    });

    const confirmKey = `test_idem_confirm_${order.id}`;
    mockPaymentProvider.confirmIntent(payment.paymentReference);
    const result1 = await confirmAndProvision({
      orderId: order.id,
      userId: testUserId,
      idempotencyKey: confirmKey,
    });

    // Count eSIMs for this order before duplicate
    const esimCountBefore = await db.esim.count({ where: { orderId: order.id } });
    expect(esimCountBefore).toBe(1);

    // Duplicate confirm — should return the same result, not create a second eSIM
    mockPaymentProvider.confirmIntent(payment.paymentReference);
    const result2 = await confirmAndProvision({
      orderId: order.id,
      userId: testUserId,
      idempotencyKey: confirmKey,
    });

    const esimCountAfter = await db.esim.count({ where: { orderId: order.id } });
    expect(esimCountAfter).toBe(1); // still 1, not 2
    expect(result1.esimId).toBe(result2.esimId);
  }, 60000);
});

describe("failure handling", () => {
  it("rejects provisioning for unpaid orders", async () => {
    const order = await createOrder({
      userId: testUserId,
      planId,
      idempotencyKey: `test_fail_unpaid_${Date.now()}`,
    });
    createdOrderIds.push(order.id);

    // Don't initiate payment — try to provision directly
    await expect(
      provisionOrderESIM({
        orderId: order.id,
        userId: testUserId,
        idempotencyKey: `test_prov_fail_${order.id}`,
      })
    ).rejects.toThrow();
  }, 60000);

  it("rejects access to another user's order", async () => {
    // Create a second user
    const otherUser = await db.user.create({
      data: {
        email: `other-user-${Date.now()}@roamlink.test`,
        name: "Other User",
        passwordHash: await import("@/lib/security").then(m => m.hashPassword("test12345")),
        role: "customer",
      },
    });

    const order = await createOrder({
      userId: testUserId,
      planId,
      idempotencyKey: `test_auth_${Date.now()}`,
    });
    createdOrderIds.push(order.id);

    // Other user tries to access this order
    await expectReject(() => getOrder(order.id, otherUser.id));

    await db.user.delete({ where: { id: otherUser.id } });
  }, 60000);
});
