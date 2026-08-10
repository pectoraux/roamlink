/**
 * Webhook idempotency tests.
 * Verifies duplicate webhook delivery is harmless.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup, cleanupTestOrders } from "./setup";

const createdOrderIds: string[] = [];

beforeAll(async () => {
  await ensureTestSetup();
});

afterAll(async () => {
  await cleanupTestOrders(createdOrderIds);
  await db.$disconnect();
});

describe("webhook idempotency", () => {
  it("creates a webhook event with provider + externalId", async () => {
    const event = await db.webhookEvent.create({
      data: {
        provider: "mock",
        eventType: "esim.usage_updated",
        externalId: `test-evt-${Date.now()}`,
        payload: JSON.stringify({ test: true }),
        processed: false,
      },
    });

    expect(event.id).toBeTruthy();
    expect(event.processed).toBe(false);

    // Mark as processed
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { processed: true, processedAt: new Date() },
    });

    const updated = await db.webhookEvent.findUnique({ where: { id: event.id } });
    expect(updated!.processed).toBe(true);
  });

  it("enforces uniqueness on (provider, externalId)", async () => {
    const externalId = `test-dedup-${Date.now()}`;
    await db.webhookEvent.create({
      data: {
        provider: "mock",
        eventType: "test",
        externalId,
        payload: "{}",
        processed: false,
      },
    });

    // Duplicate insert should fail due to @@unique([provider, externalId])
    let duplicateError: unknown = null;
    try {
      await db.webhookEvent.create({
        data: {
          provider: "mock",
          eventType: "test",
          externalId, // same externalId
          payload: "{}",
          processed: false,
        },
      });
    } catch (e) {
      duplicateError = e;
    }
    expect(duplicateError).toBeTruthy();
  });

  it("upsert pattern allows safe dedup", async () => {
    const externalId = `test-upsert-${Date.now()}`;

    // First "delivery" — create
    const first = await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: "mock", externalId } },
      create: { provider: "mock", eventType: "test", externalId, payload: "{}", processed: false },
      update: {},
    });
    expect(first.processed).toBe(false);

    // Mark as processed (simulate handling)
    await db.webhookEvent.update({
      where: { id: first.id },
      data: { processed: true, processedAt: new Date() },
    });

    // Second "delivery" — upsert returns existing (already processed)
    const second = await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: "mock", externalId } },
      create: { provider: "mock", eventType: "test", externalId, payload: "{}", processed: false },
      update: {},
    });
    expect(second.id).toBe(first.id);
    expect(second.processed).toBe(true); // still processed — duplicate is harmless
  });
});
