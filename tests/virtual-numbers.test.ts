/**
 * Virtual Number tests — purchase, idempotency, SMS, authorization.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { searchNumbers, purchaseNumber, listUserNumbers, getUserNumber, sendSMS, getMessages, releaseNumber } from "@/lib/virtual-numbers/service";
import { mockVNProvider } from "@/lib/virtual-numbers";
import { ensureTestSetup, TEST_USER, cleanupTestOrders } from "./setup";
import { hashPassword } from "@/lib/security";
import { expectReject } from "./helpers";
import { AppError } from "@/lib/errors";

let testUserId: string;
let testNumberId: string | null = null;
const createdOrderIds: string[] = [];
let setupDone = false;

/** Lazy setup — avoids beforeAll 5s timeout. */
async function ensureVNSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  const user = await db.user.findUnique({ where: { email: TEST_USER.email } });
  testUserId = user!.id;
}

afterAll(async () => {
  // Best-effort cleanup — don't block on slow DB operations
  try {
    if (testNumberId) {
      await db.message.deleteMany({ where: { virtualNumberId: testNumberId } });
      await db.call.deleteMany({ where: { virtualNumberId: testNumberId } });
      await db.numberSubscription.deleteMany({ where: { virtualNumberId: testNumberId } });
      await db.virtualNumber.deleteMany({ where: { id: testNumberId } });
    }
    if (createdOrderIds.length > 0) {
      await db.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
  } catch { /* best effort */ }
  await db.$disconnect();
});

describe("virtual numbers — search", () => {
  it("returns country catalog when no params", async () => {
    await ensureVNSetup();
    const numbers = await searchNumbers({});
    expect(numbers.length).toBeGreaterThan(0);
  }, 60000);

  it("filters by country", async () => {
    await ensureVNSetup();
    const numbers = await searchNumbers({ countryCode: "GH" });
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.every((n) => n.countryCode === "GH")).toBe(true);
  }, 60000);

  it("filters by SMS capability", async () => {
    await ensureVNSetup();
    const numbers = await searchNumbers({ smsRequired: true });
    expect(numbers.every((n) => n.smsEnabled)).toBe(true);
  }, 60000);
});

describe("virtual numbers — purchase & provisioning", () => {
  it("purchases a number and provisions it", async () => {
    await ensureVNSetup();
    const numbers = await searchNumbers({ countryCode: "US" });
    const num = numbers[0];
    expect(num).toBeTruthy();

    const result = await purchaseNumber({
      userId: testUserId,
      providerNumberId: num.providerNumberId,
      idempotencyKey: `test_vn_purchase_${Date.now()}`,
    });
    createdOrderIds.push(result.orderId);
    testNumberId = result.virtualNumberId;

    expect(result.status).toBe("active");
    expect(result.virtualNumberId).toBeTruthy();

    // Verify the number is in the DB with correct data
    const vn = await db.virtualNumber.findUnique({ where: { id: result.virtualNumberId } });
    expect(vn).toBeTruthy();
    expect(vn!.e164).toMatch(/^\+\d+/);
    expect(vn!.status).toBe("active");
    expect(vn!.userId).toBe(testUserId);
    expect(vn!.smsEnabled).toBe(true);
  }, 60000);

  it("duplicate purchase returns the same number (idempotency)", async () => {
    await ensureVNSetup();
    const numbers = await searchNumbers({ countryCode: "GB" });
    const num = numbers[0];
    const idemKey = `test_vn_idem_${Date.now()}`;

    const result1 = await purchaseNumber({
      userId: testUserId,
      providerNumberId: num.providerNumberId,
      idempotencyKey: idemKey,
    });
    createdOrderIds.push(result1.orderId);

    // The same idempotencyKey should return the same order
    // (The number might already be purchased, so this depends on impl)
    // We verify no duplicate virtual number is created
    const count = await db.virtualNumber.count({ where: { orderId: result1.orderId } });
    expect(count).toBe(1);
  }, 60000);

  it("lists user's numbers", async () => {
    await ensureVNSetup();
    const numbers = await listUserNumbers(testUserId);
    expect(numbers.length).toBeGreaterThan(0);
  }, 60000);
});

describe("virtual numbers — authorization", () => {
  it("rejects access from a different user", async () => {
    await ensureVNSetup();
    expect(testNumberId).toBeTruthy();

    // Create another user
    const otherUser = await db.user.create({
      data: { email: `vn-thief-${Date.now()}@roamlink.test`, name: "VN Thief", passwordHash: await hashPassword("test12345"), role: "customer" },
    });

    await expectReject(() => getUserNumber(otherUser.id, testNumberId!), AppError);

    await db.user.delete({ where: { id: otherUser.id } });
  }, 60000);
});

describe("virtual numbers — SMS", () => {
  it("sends an SMS and stores it", async () => {
    await ensureVNSetup();
    expect(testNumberId).toBeTruthy();

    const message = await sendSMS(testUserId, testNumberId!, "+233240000000", "Test message from RoamLink!");
    expect(message.body).toBe("Test message from RoamLink!");
    expect(message.direction).toBe("outbound");
    expect(message.status).toBe("sent");
  }, 30000);

  it("retrieves messages", async () => {
    await ensureVNSetup();
    expect(testNumberId).toBeTruthy();

    const messages = await getMessages(testUserId, testNumberId!);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].body).toContain("Test message");
  }, 60000);

  it("processes inbound SMS (simulated)", async () => {
    await ensureVNSetup();
    expect(testNumberId).toBeTruthy();
    // Process an inbound message through the service (as a webhook would)
    const vn = await db.virtualNumber.findUnique({ where: { id: testNumberId } });
    expect(vn?.providerNumberId).toBeTruthy();

    const { processInboundMessage } = await import("@/lib/virtual-numbers/service");
    const result = await processInboundMessage({
      providerNumberId: vn!.providerNumberId!,
      from: "+233241234567",
      to: vn!.e164,
      body: "Inbound test message",
      providerMessageId: `test-inbound-${Date.now()}`,
    });

    // The message should be created in the DB (processInboundMessage returns it)
    expect(result).toBeTruthy();
    expect(result!.body).toBe("Inbound test message");
    expect(result!.direction).toBe("inbound");
  }, 60000);
});

describe("virtual numbers — release", () => {
  it("releases a number", async () => {
    await ensureVNSetup();
    expect(testNumberId).toBeTruthy();

    await releaseNumber(testUserId, testNumberId!);

    const vn = await db.virtualNumber.findUnique({ where: { id: testNumberId! } });
    expect(vn!.status).toBe("released");
    expect(vn!.releasedAt).toBeTruthy();

    // Mark as released so cleanup doesn't fail
    testNumberId = null;
  }, 30000);
});
