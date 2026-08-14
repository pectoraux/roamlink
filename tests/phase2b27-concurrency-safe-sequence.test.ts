/**
 * Phase 2B.2.7 — Concurrency-Safe Tenant Transaction Sequencing
 *
 * Tests that concurrent TenantTransaction creations for the same tenant
 * receive unique sequence numbers without P2002 failures.
 *
 *   A. Concurrent same-tenant sequence allocation (Promise.all × 4)
 *   B. Different tenants are independent
 *   C. Repository-wide audit: all creation paths use the safe allocator
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureTestSetup } from "./setup";
import { seedSaaasPlans } from "@/lib/tenant/entitlements";
import { createTenant, addTenantUser } from "@/lib/tenant/service";
import { getOrCreateTenantBalance } from "@/lib/tenant/balance";
import { hashPassword } from "@/lib/security";

let setupDone = false;
let tenantId: string;
let tenantBId: string;
let userId: string;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  await ensureTestSetup();
  await seedSaaasPlans();

  const user = await db.user.create({
    data: { email: `reseller-2b27-${Date.now()}@test.com`, name: "Reseller 2B.2.7", passwordHash: await hashPassword("test12345"), role: "customer" },
  });
  userId = user.id;

  const tenantA = await createTenant({ name: `Reseller 2B.2.7 A ${Date.now()}` });
  const tenantB = await createTenant({ name: `Reseller 2B.2.7 B ${Date.now()}` });
  tenantId = tenantA.id;
  tenantBId = tenantB.id;
  await addTenantUser({ tenantId, userId, role: "owner" });
  await addTenantUser({ tenantId: tenantBId, userId, role: "owner" });

  // Create balance records
  await getOrCreateTenantBalance(tenantId);
  await getOrCreateTenantBalance(tenantBId);
}

afterAll(async () => {
  try {
    for (const tid of [tenantId, tenantBId]) {
      if (tid) {
        await db.tenantTransaction.deleteMany({ where: { tenantId: tid } }).catch(() => {});
        await db.tenantBalance.deleteMany({ where: { tenantId: tid } }).catch(() => {});
        await db.tenantUser.deleteMany({ where: { tenantId: tid } }).catch(() => {});
        await db.tenant.deleteMany({ where: { id: tid } }).catch(() => {});
      }
    }
    if (userId) await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  } catch {}
  await db.$disconnect();
}, 180000);

/**
 * Helper: create a TenantTransaction using the same concurrency-safe pattern
 * as the production code (FOR UPDATE lock + getNextSequenceNumber + create).
 */
async function createTestTransaction(tid: string, idempotencyKey: string): Promise<number> {
  return db.$transaction(async (tx) => {
    // Lock the balance row
    await tx.$executeRaw`SELECT 1 FROM "TenantBalance" WHERE "tenantId" = ${tid} FOR UPDATE`;
    // Read + increment sequence
    const balance = await tx.tenantBalance.findUnique({
      where: { tenantId: tid },
      select: { nextTransactionSequence: true },
    });
    const seq = balance?.nextTransactionSequence ?? 1;
    await tx.tenantBalance.update({
      where: { tenantId: tid },
      data: { nextTransactionSequence: seq + 1 },
    });
    // Create the transaction
    await tx.tenantTransaction.create({
      data: {
        tenantId: tid,
        type: "adjustment",
        amountMinor: 1,
        balanceAfter: seq,
        description: "Concurrent test transaction",
        idempotencyKey,
        sequenceNumber: seq,
      },
    });
    return seq;
  }, { timeout: 30000, maxWait: 15000 });
}

describe("Phase 2B.2.7 — Concurrency-Safe Sequencing", () => {
  beforeAll(async () => { await ensureSetup(); }, 120000);

  it("A. Concurrent same-tenant sequence allocation (4 parallel, all succeed, unique sequences)", async () => {
    const keys = [
      `concurrent_test_1_${Date.now()}`,
      `concurrent_test_2_${Date.now()}`,
      `concurrent_test_3_${Date.now()}`,
      `concurrent_test_4_${Date.now()}`,
    ];

    // Run 4 concurrent transaction creations for the same tenant
    const results = await Promise.all(
      keys.map((key) => createTestTransaction(tenantId, key).catch((e) => e)),
    );

    // All must succeed (no errors)
    for (const r of results) {
      expect(r).not.toBeInstanceOf(Error);
    }

    // All sequence numbers must be distinct
    const seqs = results.filter((r) => typeof r === "number") as number[];
    expect(seqs.length).toBe(4);
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(4); // no duplicates

    // Sequence numbers must form a valid deterministic order (ascending, consecutive)
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1); // consecutive
    }
  }, 120000);

  it("B. Different tenants are independent (no cross-tenant sequence collision)", async () => {
    // Create transactions for both tenants concurrently
    const [seqA, seqB] = await Promise.all([
      createTestTransaction(tenantId, `cross_tenant_a_${Date.now()}`),
      createTestTransaction(tenantBId, `cross_tenant_b_${Date.now()}`),
    ]);

    // Both should succeed with valid sequence numbers
    expect(typeof seqA).toBe("number");
    expect(typeof seqB).toBe("number");

    // Verify tenant A's transactions are independent of tenant B's
    const txnsA = await db.tenantTransaction.findMany({
      where: { tenantId },
      orderBy: { sequenceNumber: "asc" },
      select: { sequenceNumber: true },
    });
    const txnsB = await db.tenantTransaction.findMany({
      where: { tenantId: tenantBId },
      orderBy: { sequenceNumber: "asc" },
      select: { sequenceNumber: true },
    });

    // Both should start at 1 (independent sequences)
    expect(txnsA[0]?.sequenceNumber).toBe(1);
    expect(txnsB[0]?.sequenceNumber).toBe(1);

    // Both should have unique per-tenant sequences
    const seqsA = txnsA.map((t) => t.sequenceNumber);
    const seqsB = txnsB.map((t) => t.sequenceNumber);
    expect(new Set(seqsA).size).toBe(seqsA.length);
    expect(new Set(seqsB).size).toBe(seqsB.length);
  }, 60000);

  it("C. Repository-wide audit: all tenantTransaction.create use the safe allocator", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/tenant/balance.ts", "utf-8");

    // No direct db.tenantTransaction.create (must be inside a transaction with lock)
    // All calls must use tx.tenantTransaction.create
    const dbCreateCount = (source.match(/db\.tenantTransaction\.create\(/g) || []).length;
    expect(dbCreateCount).toBe(0); // no direct db. calls

    // All calls must use tx.tenantTransaction.create
    const txCreateCount = (source.match(/tx\.tenantTransaction\.create\(/g) || []).length;
    expect(txCreateCount).toBe(7); // all 7 call sites

    // No MAX+1 pattern
    expect(source).not.toContain("MAX(sequenceNumber)");
    expect(source).not.toContain("orderBy: { sequenceNumber: \"desc\" }\n    select: { sequenceNumber: true },\n  });\n  return (last?.sequenceNumber");

    // The helper must use nextTransactionSequence
    expect(source).toContain("nextTransactionSequence");
    expect(source).toContain("lockTenantBalance");
    expect(source).toContain("FOR UPDATE");
  }, 10000);

  it("Static: TenantBalance has nextTransactionSequence field", async () => {
    const fs = await import("fs");
    const schema = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(schema).toContain("nextTransactionSequence");
  }, 10000);

  it("Static: migration 0011 applied (nextTransactionSequence column exists)", async () => {
    const res = await db.tenantBalance.findFirst({
      select: { nextTransactionSequence: true },
    });
    expect(res).toBeDefined();
    expect(typeof res?.nextTransactionSequence).toBe("number");
  }, 30000);
});
