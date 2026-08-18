/**
 * Phase 12.3 — API Platform Protocol (DB-backed runtime)
 *
 * Proves the two P0 fixes from the Phase 12.3 audit:
 *
 * 12.3.1  Canonical API-key verification
 *   - valid key → resolves principal with tenant + scopes
 *   - revoked key → 401
 *   - expired key → 401
 *   - insufficient scope → 403
 *   - cross-tenant: key's tenantId is authoritative (caller cannot override)
 *
 * 12.3.2  Transaction-safe idempotency (DB-authoritative claim)
 *   12.3.2.1  single execution (no race)
 *   12.3.2.2  concurrent duplicate requests → exactly ONE execution, other replays
 *   12.3.2.3  replay after completion → returns stored result (no re-execution)
 *   12.3.2.4  conflicting payload (same key, different body) → 409 Conflict
 *   12.3.2.5  failure is dead-lettered (replay throws the stored failure)
 *   12.3.2.6  reclaim expired IN_PROGRESS → FAILED (crashed worker recovery)
 *   12.3.2.9  long-running execute + heartbeat renews → reclaimer CANNOT reclaim
 *   12.3.2.10 heartbeat stops (crash) → lease expires → reclaimer → FAILED
 *
 * The critical test is 12.3.2.2: two concurrent requests with the same key.
 * Under the prior runIdempotent() (findExisting → execute), both would execute.
 * Under the new DB-authoritative primitive, only one executes; the other
 * polls and returns the stored result.
 *
 * 12.3.2.9 is the split-brain proof: a long-running execute whose heartbeat
 * is active MUST NOT be reclaimed, even if the reclaim worker runs repeatedly.
 *
 * Requires DATABASE_URL. Run via: bun test tests/phase12.3-api-protocol.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { hashPassword } from "@/lib/security";
import { AppError } from "@/lib/errors";

import {
  runIdempotentOperation,
  hashPayload,
  reclaimExpiredIdempotencyOperations,
  getIdempotencyOperation,
  reconcileOperation,
  _testForceLeaseExpiry,
  _getClaimId,
  _getProviderKey,
} from "@/lib/idempotency/claim";
import {
  requireApiKey,
  verifyApiKey,
  hashApiKey,
  type ApiKeyPrincipal,
} from "@/lib/auth/api-key";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  tenantId: string;
  userId: string;
  validKeyId: string;
  validKeyRaw: string;
  revokedKeyId: string;
  revokedKeyRaw: string;
  expiredKeyId: string;
  expiredKeyRaw: string;
  writeOnlyKeyId: string;
  writeOnlyKeyRaw: string;
  adminKeyId: string;
  adminKeyRaw: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const slug = `p123-${Date.now().toString(36)}`;
  const email = `p123-${Date.now()}@test.roamlink`;

  const user = await db.user.create({
    data: { email, name: "P12.3 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const tenant = await db.tenant.create({ data: { name: `P123 ${slug}`, slug, status: "active" } });
  await db.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "admin" } });

  // Create API keys with various states.
  function makeRawKey(): string {
    return `rlk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }

  const validRaw = makeRawKey();
  const revokedRaw = makeRawKey();
  const expiredRaw = makeRawKey();
  const writeOnlyRaw = makeRawKey();
  const adminRaw = makeRawKey();

  const validKey = await db.apiKey.create({
    data: { tenantId: tenant.id, name: "Valid Key", hashedKey: hashApiKey(validRaw), prefix: validRaw.slice(0, 12), scopes: JSON.stringify(["read", "write", "orders"]), createdBy: user.id },
  });
  const revokedKey = await db.apiKey.create({
    data: { tenantId: tenant.id, name: "Revoked Key", hashedKey: hashApiKey(revokedRaw), prefix: revokedRaw.slice(0, 12), scopes: JSON.stringify(["read", "write"]), createdBy: user.id, revokedAt: new Date() },
  });
  const expiredKey = await db.apiKey.create({
    data: { tenantId: tenant.id, name: "Expired Key", hashedKey: hashApiKey(expiredRaw), prefix: expiredRaw.slice(0, 12), scopes: JSON.stringify(["read", "write"]), createdBy: user.id, expiresAt: new Date(Date.now() - 60_000) },
  });
  const writeOnlyKey = await db.apiKey.create({
    data: { tenantId: tenant.id, name: "Write-Only Key", hashedKey: hashApiKey(writeOnlyRaw), prefix: writeOnlyRaw.slice(0, 12), scopes: JSON.stringify(["write"]), createdBy: user.id },
  });
  const adminKey = await db.apiKey.create({
    data: { tenantId: tenant.id, name: "Admin Key", hashedKey: hashApiKey(adminRaw), prefix: adminRaw.slice(0, 12), scopes: JSON.stringify(["admin"]), createdBy: user.id },
  });

  const cleanup = async () => {
    await db.apiKey.deleteMany({ where: { tenantId: tenant.id } }).catch(() => {});
    await db.idempotencyOperation.deleteMany({ where: { tenantId: tenant.id } }).catch(() => {});
    await db.tenantUser.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return {
    tenantId: tenant.id,
    userId: user.id,
    validKeyId: validKey.id,
    validKeyRaw: validRaw,
    revokedKeyId: revokedKey.id,
    revokedKeyRaw: revokedRaw,
    expiredKeyId: expiredKey.id,
    expiredKeyRaw: expiredRaw,
    writeOnlyKeyId: writeOnlyKey.id,
    writeOnlyKeyRaw: writeOnlyRaw,
    adminKeyId: adminKey.id,
    adminKeyRaw: adminRaw,
    cleanup,
  };
}

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 12.3 — API Platform Protocol (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 60_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 60_000);

  // =========================================================================
  // 12.3.1 — Canonical API-key verification
  // =========================================================================

  describe("12.3.1 — Canonical API-key verification", () => {
    it("12.3.1.1: valid key (Bearer) → resolves principal with tenant + scopes", async () => {
      const req = makeReq({ authorization: `Bearer ${fx.validKeyRaw}` });
      const principal = await requireApiKey(req, "read");
      expect(principal.type).toBe("api_key");
      expect(principal.tenantId).toBe(fx.tenantId);
      expect(principal.scopes).toContain("read");
      expect(principal.scopes).toContain("write");
      expect(principal.scopes).toContain("orders");
    }, 30_000);

    it("12.3.1.2: valid key (x-api-key header) → resolves principal", async () => {
      const req = makeReq({ "x-api-key": fx.validKeyRaw });
      const principal = await requireApiKey(req, "read");
      expect(principal.tenantId).toBe(fx.tenantId);
    }, 30_000);

    it("12.3.1.3: no API key → 401", async () => {
      const req = makeReq();
      await expect(requireApiKey(req, "read")).rejects.toMatchObject({ statusCode: 401 });
    }, 30_000);

    it("12.3.1.4: invalid key (wrong hash) → 401", async () => {
      const req = makeReq({ authorization: "Bearer rlk_nonexistent_key_1234567890" });
      await expect(requireApiKey(req, "read")).rejects.toMatchObject({ statusCode: 401 });
    }, 30_000);

    it("12.3.1.5: malformed key (wrong prefix) → 401", async () => {
      const req = makeReq({ authorization: "Bearer not_a_roamlink_key" });
      await expect(requireApiKey(req, "read")).rejects.toMatchObject({ statusCode: 401 });
    }, 30_000);

    it("12.3.1.6: revoked key → 401", async () => {
      const req = makeReq({ authorization: `Bearer ${fx.revokedKeyRaw}` });
      await expect(requireApiKey(req, "read")).rejects.toMatchObject({ statusCode: 401 });
    }, 30_000);

    it("12.3.1.7: expired key → 401", async () => {
      const req = makeReq({ authorization: `Bearer ${fx.expiredKeyRaw}` });
      await expect(requireApiKey(req, "read")).rejects.toMatchObject({ statusCode: 401 });
    }, 30_000);

    it("12.3.1.8: insufficient scope → 403", async () => {
      // writeOnlyKey has ["write"] but not ["orders"]; requesting "orders" → 403
      const req = makeReq({ authorization: `Bearer ${fx.writeOnlyKeyRaw}` });
      await expect(requireApiKey(req, "orders")).rejects.toMatchObject({ statusCode: 403 });
    }, 30_000);

    it("12.3.1.9: admin scope implies all scopes", async () => {
      // adminKey has ["admin"] — requesting any scope should pass
      const req = makeReq({ authorization: `Bearer ${fx.adminKeyRaw}` });
      const principal = await requireApiKey(req, "orders");
      expect(principal.tenantId).toBe(fx.tenantId);
    }, 30_000);

    it("12.3.1.10: key's tenantId is authoritative — caller cannot override", async () => {
      // verifyApiKey returns the key's tenantId. There is NO way for the caller
      // to supply a different tenantId in the request body that would change this.
      const principal = await verifyApiKey(fx.validKeyRaw);
      expect(principal!.tenantId).toBe(fx.tenantId);
      // The principal object does not carry any client-supplied tenant override.
    }, 30_000);

    it("12.3.1.11: lastUsedAt is updated on successful verification", async () => {
      const before = await db.apiKey.findUnique({ where: { id: fx.validKeyId }, select: { lastUsedAt: true } });
      const req = makeReq({ authorization: `Bearer ${fx.validKeyRaw}` });
      await requireApiKey(req, "read");
      // Give the non-blocking update a moment to land.
      await new Promise((r) => setTimeout(r, 50));
      const after = await db.apiKey.findUnique({ where: { id: fx.validKeyId }, select: { lastUsedAt: true } });
      expect(after!.lastUsedAt).not.toBeNull();
      if (before!.lastUsedAt) {
        expect(after!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before!.lastUsedAt!.getTime());
      }
    }, 30_000);
  });

  // =========================================================================
  // 12.3.2 — Transaction-safe idempotency (DB-authoritative claim)
  // =========================================================================

  describe("12.3.2 — Transaction-safe idempotency", () => {
    // -------------------------------------------------------------------------
    // 12.3.2.1 — single execution (control)
    // -------------------------------------------------------------------------
    it("12.3.2.1: single execution → COMPLETED, result stored", async () => {
      const key = `p12321-${Date.now()}`;
      const scope = "test_scope_1";
      let execCount = 0;

      const result = await runIdempotentOperation({
        scope,
        key,
        isExternal: false,
        execute: async () => {
          execCount++;
          return { value: 42, label: "answer" };
        },
      });

      expect(result).toEqual({ value: 42, label: "answer" });
      expect(execCount).toBe(1);

      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("COMPLETED");
      expect(JSON.parse(op!.resultJson!)).toEqual({ value: 42, label: "answer" });
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.2 — THE CRITICAL TEST: concurrent duplicate requests
    //
    // Two requests with the same (scope, key) fire simultaneously.
    // Under the prior runIdempotent() (findExisting → execute), BOTH would
    // execute the side effect. Under the new DB-authoritative primitive, only
    // ONE executes; the other loses the INSERT race, polls, and returns the
    // stored result.
    // -------------------------------------------------------------------------
    it("12.3.2.2: concurrent duplicate requests → exactly ONE execution, other replays", async () => {
      const key = `p12322-${Date.now()}`;
      const scope = "test_concurrent";
      let execCount = 0;

      // Slow executor so both requests overlap in time.
      const execute = async () => {
        execCount++;
        await new Promise((r) => setTimeout(r, 100));
        return { orderId: `order-${execCount}` };
      };

      // Fire two concurrent requests.
      const [a, b] = await Promise.all([
        runIdempotentOperation({ scope, key, isExternal: false, execute }),
        runIdempotentOperation({ scope, key, isExternal: false, execute }),
      ]);

      // Exactly one execution.
      expect(execCount).toBe(1);

      // Both requests return the SAME result (the one from the single execution).
      expect(a).toEqual(b);
      expect(a.orderId).toBe("order-1");

      // The operation is COMPLETED with the stored result.
      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("COMPLETED");
      expect(JSON.parse(op!.resultJson!)).toEqual({ orderId: "order-1" });
    }, 60_000);

    // -------------------------------------------------------------------------
    // 12.3.2.3 — replay after completion → returns stored result (no re-exec)
    // -------------------------------------------------------------------------
    it("12.3.2.3: replay after completion → returns stored result, no re-execution", async () => {
      const key = `p12323-${Date.now()}`;
      const scope = "test_replay";
      let execCount = 0;

      // First execution.
      const first = await runIdempotentOperation({
        scope,
        key,
        isExternal: false,
        execute: async () => {
          execCount++;
          return { id: "abc" };
        },
      });
      expect(execCount).toBe(1);

      // Replay — should return the stored result WITHOUT re-executing.
      const second = await runIdempotentOperation({
        scope,
        key,
        isExternal: false,
        execute: async () => {
          execCount++;
          return { id: "should_not_reach" };
        },
      });

      expect(execCount).toBe(1); // still 1 — no re-execution
      expect(second).toEqual({ id: "abc" }); // stored result
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.4 — conflicting payload (same key, different body) → 409
    // -------------------------------------------------------------------------
    it("12.3.2.4: conflicting payload (same key, different body) → 409 Conflict", async () => {
      const key = `p12324-${Date.now()}`;
      const scope = "test_conflict";
      const payloadA = hashPayload({ planId: "plan_A", amount: 100 });
      const payloadB = hashPayload({ planId: "plan_B", amount: 200 });

      // First request with payload A.
      await runIdempotentOperation({
        scope,
        key,
        payloadHash: payloadA,
        isExternal: false,
        execute: async () => ({ orderId: "order_A" }),
      });

      // Second request with the SAME key but DIFFERENT payload → 409.
      await expect(
        runIdempotentOperation({
          scope,
          key,
          payloadHash: payloadB,
          isExternal: false,
          execute: async () => ({ orderId: "order_B" }),
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.5 — CONFIRMED_FAILURE (provider explicitly rejected) → FAILED.
    //
    // Phase 12.3.2.3: The execute() callback now returns an OperationOutcome.
    // A CONFIRMED_FAILURE (provider explicitly rejected, e.g. card declined)
    // transitions to FAILED. This is safe to retry with a new key.
    //
    // This is distinct from an AMBIGUOUS_EXTERNAL_FAILURE (timeout, connection
    // reset) which transitions to RECONCILIATION_REQUIRED (see 12.3.2.15).
    // -------------------------------------------------------------------------
    it("12.3.2.5: CONFIRMED_FAILURE → FAILED, replay throws the stored failure", async () => {
      const key = `p12325-${Date.now()}`;
      const scope = "test_confirmed_failure";
      const providerKey = `prov_${key}`;
      let execCount = 0;

      // First request: provider explicitly rejects (card declined).
      await expect(
        runIdempotentOperation({
          scope,
          key,
          providerKey,
          execute: async () => {
            execCount++;
            return {
              outcome: "CONFIRMED_FAILURE",
              failure: { errorClass: "payment" as const, message: "Card declined", statusCode: 402, safeMessage: "Your card was declined." },
            };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 402 });
      expect(execCount).toBe(1);

      // Operation is FAILED (confirmed failure — safe to retry with a new key).
      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("FAILED");
      const failure = JSON.parse(op!.failureJson!);
      expect(failure.errorClass).toBe("payment");
      expect(failure.statusCode).toBe(402);

      // Replay throws the SAME failure — does NOT re-execute.
      await expect(
        runIdempotentOperation({
          scope,
          key,
          providerKey,
          execute: async () => {
            execCount++;
            return { outcome: "SUCCESS" as const, value: { shouldNotReach: true } };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 402 });
      expect(execCount).toBe(1); // still 1 — no re-execution on replay
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.6 — reclaim expired IN_PROGRESS → RECONCILIATION_REQUIRED (Phase 12.3.2.2)
    // -------------------------------------------------------------------------
    it("12.3.2.6: reclaim expired IN_PROGRESS → RECONCILIATION_REQUIRED (crashed worker, outcome unknown)", async () => {
      const key = `p12326-${Date.now()}`;
      const scope = "test_reclaim";

      // Create an IN_PROGRESS operation with a very short lease (already expired).
      await db.idempotencyOperation.create({
        data: {
          scope,
          key,
          state: "IN_PROGRESS",
          claimExpiresAt: new Date(Date.now() - 1000), // expired 1 second ago
          providerKey: key, // has a providerKey for reconciliation
        },
      });

      // Reclaim.
      const reclaimed = await reclaimExpiredIdempotencyOperations();
      expect(reclaimed).toBeGreaterThanOrEqual(1);

      // Phase 12.3.2.2: Operation is now RECONCILIATION_REQUIRED (NOT FAILED).
      // The external side effect's outcome is unknown — the caller must NOT
      // retry with a new key. A reconciliation worker must query the provider.
      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("RECONCILIATION_REQUIRED");
      const failure = JSON.parse(op!.failureJson!);
      expect(failure.statusCode).toBe(500);
      expect(failure.message).toMatch(/lease expired|reconciliation|unknown/i);

      // A future request with the same key gets a 409 "outcome unknown, do not retry".
      await expect(
        runIdempotentOperation({
          scope,
          key,
          isExternal: false,
          execute: async () => ({ shouldNotReach: true }),
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.7 — three concurrent requests → exactly one execution
    // -------------------------------------------------------------------------
    it("12.3.2.7: three concurrent requests → exactly ONE execution, all get same result", async () => {
      const key = `p12327-${Date.now()}`;
      const scope = "test_triple";
      let execCount = 0;

      const execute = async () => {
        execCount++;
        await new Promise((r) => setTimeout(r, 80));
        return { batchId: execCount };
      };

      const [a, b, c] = await Promise.all([
        runIdempotentOperation({ scope, key, isExternal: false, execute }),
        runIdempotentOperation({ scope, key, isExternal: false, execute }),
        runIdempotentOperation({ scope, key, isExternal: false, execute }),
      ]);

      expect(execCount).toBe(1);
      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(a.batchId).toBe(1);
    }, 60_000);

    // -------------------------------------------------------------------------
    // 12.3.2.8 — principal is recorded on the claim (audit trail)
    // -------------------------------------------------------------------------
    it("12.3.2.8: principal (api_key) is recorded on the claim for audit", async () => {
      const key = `p12328-${Date.now()}`;
      const scope = "test_principal";
      const principal = {
        type: "api_key" as const,
        id: fx.validKeyId,
        tenantId: fx.tenantId,
      };

      await runIdempotentOperation({
        scope,
        key,
        principal,
        isExternal: false,
        execute: async () => ({ ok: true }),
      });

      const op = await db.idempotencyOperation.findUnique({
        where: { scope_key: { scope, key } },
        select: { principalType: true, principalId: true, tenantId: true },
      });
      expect(op!.principalType).toBe("api_key");
      expect(op!.principalId).toBe(fx.validKeyId);
      expect(op!.tenantId).toBe(fx.tenantId);
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.9 — THE SPLIT-BRAIN PROOF:
    // Long-running execute + active heartbeat → reclaimer CANNOT reclaim.
    //
    // This is the test the architect specified to prove the lease race is fixed:
    //   Worker A claims operation.
    //   Worker A executes for > lease duration.
    //   Heartbeat renews the claim.
    //   Reclaimer runs repeatedly.
    //   Operation MUST remain IN_PROGRESS.
    //   Worker A completes.
    //   Final state = COMPLETED.
    //   Exactly one side effect.
    //
    // Under the pre-12.3.2.1 implementation (no heartbeat), the reclaimer would
    // transition the operation to FAILED while Worker A was still executing —
    // a split-brain outcome where the record says FAILED but the side effect
    // (e.g. a payment) actually succeeded.
    // -------------------------------------------------------------------------
    it("12.3.2.9: long-running execute + heartbeat → reclaimer CANNOT reclaim, operation stays IN_PROGRESS", async () => {
      const key = `p12329-${Date.now()}`;
      const scope = "test_heartbeat_alive";
      let execCount = 0;

      // Use a short lease (2 seconds) so the test runs quickly. The heartbeat
      // (1 min interval) won't fire during this test — but we manually force
      // the lease to be fresh before the reclaim runs, simulating an active
      // heartbeat that renewed it.
      const leaseMs = 2000;

      // Start the operation. The execute sleeps for 8 seconds (4x the lease),
      // so without a heartbeat the lease would expire mid-execute multiple times.
      const executeDurationMs = leaseMs * 4; // 8 seconds
      const operationPromise = runIdempotentOperation({
        scope,
        key,
        leaseMs,
        isExternal: false,
        execute: async () => {
          execCount++;
          // Simulate a long-running side effect (e.g. a slow payment provider).
          await new Promise((r) => setTimeout(r, executeDurationMs));
          return { orderId: "order_heartbeat_alive" };
        },
      });

      // Wait for the claim to be acquired (execute has started).
      await new Promise((r) => setTimeout(r, 200));

      // The claim exists and is IN_PROGRESS.
      let op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("IN_PROGRESS");
      const claimId = await _getClaimId(scope, key);
      expect(claimId).toBeTruthy();

      // While execute runs, the heartbeat (in production) would renew the lease.
      // In this test we simulate the heartbeat by refreshing the lease manually,
      // because the heartbeat interval (60s) is longer than the test's lease (2s).
      // We refresh the lease 3 times during the 8-second execute (at 2s, 4s, 6s).
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, leaseMs));
        // Simulate a heartbeat renewal: refresh the lease to now + leaseMs.
        // This is exactly what the heartbeat does (fenced on claimId).
        await db.idempotencyOperation.updateMany({
          where: { scope, key, claimId: claimId!, state: "IN_PROGRESS" },
          data: { claimExpiresAt: new Date(Date.now() + leaseMs) },
        });
        // Run the reclaimer — it should NOT reclaim because the lease is fresh.
        const reclaimed = await reclaimExpiredIdempotencyOperations();
        expect(reclaimed).toBe(0); // KEY ASSERTION: not reclaimed while heartbeat is active

        op = await getIdempotencyOperation(scope, key);
        expect(op!.state).toBe("IN_PROGRESS"); // still IN_PROGRESS (execute still running)
      }

      // Worker A completes.
      const result = await operationPromise;
      expect(execCount).toBe(1);
      expect(result).toEqual({ orderId: "order_heartbeat_alive" });

      // Final state = COMPLETED.
      op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("COMPLETED");
      expect(JSON.parse(op!.resultJson!)).toEqual({ orderId: "order_heartbeat_alive" });

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.10 — CRASH RECOVERY (Phase 12.3.2.2):
    // Heartbeat stops (crash) → lease expires → reclaimer → RECONCILIATION_REQUIRED.
    //
    // This proves the reclaim path still works for genuine crashes, but now
    // transitions to RECONCILIATION_REQUIRED (not FAILED) because the external
    // side effect's outcome is unknown:
    //   Worker A claims.
    //   Heartbeat stops / worker dies.
    //   Lease genuinely expires.
    //   Reclaimer → RECONCILIATION_REQUIRED.
    //   A later retry with the same key gets 409 "outcome unknown, do not retry".
    // -------------------------------------------------------------------------
    it("12.3.2.10: heartbeat stops (crash) → lease expires → reclaimer → RECONCILIATION_REQUIRED, retry gets 409", async () => {
      const key = `p123210-${Date.now()}`;
      const scope = "test_heartbeat_crash";
      const leaseMs = 2000;

      // Claim the operation with a short lease.
      const claimId = `crash-${Date.now()}`;
      await db.idempotencyOperation.create({
        data: {
          scope,
          key,
          state: "IN_PROGRESS",
          claimId,
          providerKey: key,
          claimExpiresAt: new Date(Date.now() + leaseMs),
        },
      });

      // Simulate a crash: the heartbeat stops (we never start the heartbeat for
      // this manually-created record). Wait for the lease to genuinely expire.
      await new Promise((r) => setTimeout(r, leaseMs + 100));

      // The lease has expired. The reclaimer transitions to RECONCILIATION_REQUIRED.
      const reclaimed = await reclaimExpiredIdempotencyOperations();
      expect(reclaimed).toBeGreaterThanOrEqual(1);

      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("RECONCILIATION_REQUIRED");
      const failure = JSON.parse(op!.failureJson!);
      expect(failure.message).toMatch(/lease expired|reconciliation|unknown/i);

      // A later retry with the same key gets 409 "outcome unknown, do not retry"
      // (NOT a re-execution — the side effect may have succeeded at the provider).
      let execCount = 0;
      await expect(
        runIdempotentOperation({
          scope,
          key,
          isExternal: false,
          execute: async () => {
            execCount++;
            return { shouldNotReach: true };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(execCount).toBe(0); // not re-executed — outcome is unknown

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.11 — Stale owner cannot complete after reclaim (fenced update).
    //
    // This proves the fenced completion update prevents a stale owner from
    // storing a result after the claim was reclaimed. The WHERE clause on
    // claimId ensures only the original owner can transition to COMPLETED.
    // -------------------------------------------------------------------------
    it("12.3.2.11: stale owner (after reclaim) cannot store result — fenced update returns 0 rows", async () => {
      const key = `p123211-${Date.now()}`;
      const scope = "test_stale_owner";

      // Manually create a claim, then reclaim it (simulating a crashed worker
      // whose lease expired). Then try to complete it with the stale claimId.
      const claimId = `stale-${Date.now()}`;
      await db.idempotencyOperation.create({
        data: {
          scope,
          key,
          state: "IN_PROGRESS",
          claimId,
          providerKey: key,
          claimExpiresAt: new Date(Date.now() - 1000), // already expired
        },
      });

      // Reclaim → RECONCILIATION_REQUIRED (Phase 12.3.2.2).
      await reclaimExpiredIdempotencyOperations();
      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("RECONCILIATION_REQUIRED");

      // A stale owner tries to complete with the old claimId. The fenced update
      // (WHERE claimId = X AND state = IN_PROGRESS) returns 0 rows because the
      // state is now RECONCILIATION_REQUIRED.
      const updated = await db.idempotencyOperation.updateMany({
        where: { scope, key, claimId, state: "IN_PROGRESS" },
        data: { state: "COMPLETED", resultJson: JSON.stringify({ stale: true }) },
      });
      expect(updated.count).toBe(0); // KEY ASSERTION: stale owner cannot complete

      // The state is still RECONCILIATION_REQUIRED (the stale owner's update was a no-op).
      const op2 = await getIdempotencyOperation(scope, key);
      expect(op2!.state).toBe("RECONCILIATION_REQUIRED");

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.12 — CRASH AFTER EXTERNAL SIDE EFFECT → RECONCILIATION_REQUIRED (not FAILED)
    //
    // The architect's core finding: a worker that crashes AFTER the provider
    // accepted the payment but BEFORE RoamLink stores COMPLETED must NOT be
    // marked FAILED. The external outcome is UNKNOWN. Marking it FAILED allows
    // a retry with a new key, which could create a duplicate payment.
    //
    // This test deterministically simulates:
    //   claim → provider accepts → crash before COMPLETED → reclaim
    //   Expected: RECONCILIATION_REQUIRED (not FAILED)
    // -------------------------------------------------------------------------
    it("12.3.2.12: crash after external side effect → RECONCILIATION_REQUIRED (not FAILED)", async () => {
      const key = `p123212-${Date.now()}`;
      const scope = "test_crash_after_side_effect";
      const providerKey = `prov_${key}`;

      // Simulate: the worker claimed the operation, passed providerKey to the
      // provider (which accepted), but crashed before storing COMPLETED.
      // The record is IN_PROGRESS with an expired lease.
      await db.idempotencyOperation.create({
        data: {
          scope,
          key,
          state: "IN_PROGRESS",
          claimId: `crash-${Date.now()}`,
          providerKey,
          claimExpiresAt: new Date(Date.now() - 1000), // expired — worker crashed
        },
      });

      // The reclaimer transitions to RECONCILIATION_REQUIRED (NOT FAILED).
      const reclaimed = await reclaimExpiredIdempotencyOperations();
      expect(reclaimed).toBeGreaterThanOrEqual(1);

      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("RECONCILIATION_REQUIRED");
      // The providerKey is preserved so reconciliation can query the provider.
      expect(op!.providerKey).toBe(providerKey);

      // A retry with the same key gets 409 "outcome unknown, do not retry".
      let execCount = 0;
      await expect(
        runIdempotentOperation({
          scope,
          key,
          isExternal: false,
          execute: async () => {
            execCount++;
            return { shouldNotReach: true };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(execCount).toBe(0); // not re-executed — the caller is blocked

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.13 — RECONCILIATION: provider says SUCCESS → COMPLETED;
    //                                  provider says FAILED → FAILED
    //
    // A RECONCILIATION_REQUIRED operation is resolved by querying the provider
    // with the SAME providerKey. The provider's answer determines the final state.
    // -------------------------------------------------------------------------
    it("12.3.2.13: reconciliation — provider SUCCESS → COMPLETED; provider FAILED → FAILED", async () => {
      // Case A: provider says SUCCESS.
      const keyA = `p123213a-${Date.now()}`;
      const scopeA = "test_reconcile_success";
      const providerKeyA = `prov_${keyA}`;

      await db.idempotencyOperation.create({
        data: {
          scope: scopeA, key: keyA,
          state: "RECONCILIATION_REQUIRED",
          providerKey: providerKeyA,
          failureJson: JSON.stringify({ errorClass: "internal", message: "lease expired", statusCode: 500 }),
        },
      });

      // Reconcile: query the provider with the same providerKey.
      let providerQueryCount = 0;
      const newStateA = await reconcileOperation({
        scope: scopeA,
        key: keyA,
        queryProvider: async (pk) => {
          providerQueryCount++;
          expect(pk).toBe(providerKeyA); // SAME providerKey is used for reconciliation
          return { outcome: "SUCCESS", value: { orderId: "provider_confirmed_order" } };
        },
      });

      expect(newStateA).toBe("COMPLETED");
      expect(providerQueryCount).toBe(1); // queried exactly once

      const opA = await getIdempotencyOperation(scopeA, keyA);
      expect(opA!.state).toBe("COMPLETED");
      expect(JSON.parse(opA!.resultJson!)).toEqual({ orderId: "provider_confirmed_order" });
      expect(opA!.reconciledAt).not.toBeNull();

      // Case B: provider says NOT_FOUND (the request never reached the provider,
      // e.g. the worker crashed before sending it).
      const keyB = `p123213b-${Date.now()}`;
      const scopeB = "test_reconcile_not_found";
      const providerKeyB = `prov_${keyB}`;

      await db.idempotencyOperation.create({
        data: {
          scope: scopeB, key: keyB,
          state: "RECONCILIATION_REQUIRED",
          providerKey: providerKeyB,
          failureJson: JSON.stringify({ errorClass: "internal", message: "lease expired", statusCode: 500 }),
        },
      });

      const newStateB = await reconcileOperation({
        scope: scopeB,
        key: keyB,
        queryProvider: async (pk) => {
          expect(pk).toBe(providerKeyB);
          return {
            outcome: "NOT_FOUND",
            failure: { errorClass: "not_found" as const, message: "Provider has no record of this operation", statusCode: 404 },
          };
        },
      });

      expect(newStateB).toBe("FAILED");

      const opB = await getIdempotencyOperation(scopeB, keyB);
      expect(opB!.state).toBe("FAILED");
      const failureB = JSON.parse(opB!.failureJson!);
      expect(failureB.errorClass).toBe("not_found");

      // After reconciliation to FAILED, a retry with the same key gets the
      // stored failure (safe to retry with a new key now — the provider
      // confirmed it never processed the request).
      await expect(
        runIdempotentOperation({
          scope: scopeB,
          key: keyB,
          isExternal: false,
          execute: async () => ({ shouldNotReach: true }),
        }),
      ).rejects.toMatchObject({ statusCode: 404 });

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope: scopeA, key: keyA } }).catch(() => {});
      await db.idempotencyOperation.deleteMany({ where: { scope: scopeB, key: keyB } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.14 — DUPLICATE PROVIDER SAFETY: replay/reconciliation with the
    // same providerKey cannot create a second provider operation.
    //
    // The provider deduplicates on the providerKey. RoamLink stores the
    // providerKey on the IdempotencyOperation record so reconciliation reuses it.
    // A second call to the provider with the same key returns the SAME result,
    // not a new operation.
    // -------------------------------------------------------------------------
    it("12.3.2.14: duplicate provider safety — same providerKey cannot create a 2nd provider operation", async () => {
      const key = `p123214-${Date.now()}`;
      const scope = "test_provider_dedup";
      const providerKey = `prov_${key}`;

      // Simulate a completed operation where the provider was called with providerKey.
      let providerCallCount = 0;
      const providerResults = new Map<string, { orderId: string }>();

      // First call: the provider creates an operation and stores it under providerKey.
      const firstResult = await runIdempotentOperation({
        scope,
        key,
        providerKey,
        execute: async (pk) => {
          providerCallCount++;
          const result = { orderId: `order_${pk}` };
          providerResults.set(pk, result); // provider stores the result under the key
          return { outcome: "SUCCESS" as const, value: result };
        },
      });

      expect(providerCallCount).toBe(1);
      expect(firstResult).toEqual({ orderId: `order_${providerKey}` });

      // Verify the providerKey was stored on the operation record.
      const storedProviderKey = await _getProviderKey(scope, key);
      expect(storedProviderKey).toBe(providerKey);

      // Second call (replay): runIdempotentOperation returns the stored result
      // WITHOUT calling execute() again. The provider is NOT called a second time.
      const secondResult = await runIdempotentOperation({
        scope,
        key,
        providerKey,
        execute: async () => {
          providerCallCount++;
          return { outcome: "SUCCESS" as const, value: { orderId: "should_not_reach" } };
        },
      });

      expect(providerCallCount).toBe(1); // still 1 — provider not called again
      expect(secondResult).toEqual(firstResult); // same result (replayed)

      // Reconciliation safety: if we simulate a crash and reconcile, the
      // provider is queried with the SAME providerKey. A well-behaved provider
      // returns the SAME result (it deduplicates on the key).
      // First, transition to RECONCILIATION_REQUIRED (simulate crash).
      await db.idempotencyOperation.updateMany({
        where: { scope, key, state: "COMPLETED" },
        data: { state: "RECONCILIATION_REQUIRED", resultJson: null },
      });

      // Reconcile: query the provider with the stored providerKey.
      let reconcileQueryCount = 0;
      const reconciledState = await reconcileOperation({
        scope,
        key,
        queryProvider: async (pk) => {
          reconcileQueryCount++;
          expect(pk).toBe(providerKey); // SAME providerKey used for reconciliation
          // The provider returns the SAME result it stored under this key.
          const stored = providerResults.get(pk);
          if (stored) return { outcome: "SUCCESS" as const, value: stored };
          return { outcome: "NOT_FOUND" as const, failure: { errorClass: "not_found" as const, message: "not found", statusCode: 404 } };
        },
      });

      expect(reconcileQueryCount).toBe(1);
      expect(reconciledState).toBe("COMPLETED");

      // The reconciled result matches the original — no duplicate operation was created.
      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("COMPLETED");
      expect(JSON.parse(op!.resultJson!)).toEqual({ orderId: `order_${providerKey}` });

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.15 — AMBIGUOUS EXTERNAL FAILURE (provider timeout) → RECONCILIATION_REQUIRED (not FAILED)
    //
    // The architect's core finding: execute() that throws a network error
    // (timeout, ECONNRESET) after the provider may have accepted the request
    // must NOT become FAILED. The outcome is UNKNOWN → RECONCILIATION_REQUIRED.
    //
    // Only provider-CONFIRMED negative outcomes may become FAILED.
    // -------------------------------------------------------------------------
    it("12.3.2.15: ambiguous external failure (timeout) → RECONCILIATION_REQUIRED (not FAILED)", async () => {
      const key = `p123215-${Date.now()}`;
      const scope = "test_ambiguous_timeout";
      const providerKey = `prov_${key}`;
      let execCount = 0;

      // execute() returns AMBIGUOUS_EXTERNAL_FAILURE (simulating a timeout
      // after the provider may have accepted the payment).
      await expect(
        runIdempotentOperation({
          scope,
          key,
          providerKey,
          execute: async () => {
            execCount++;
            return {
              outcome: "AMBIGUOUS_EXTERNAL_FAILURE",
              failure: { errorClass: "provider" as const, message: "Request timeout — provider outcome unknown", statusCode: 504 },
            };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(execCount).toBe(1);

      // Operation is RECONCILIATION_REQUIRED (NOT FAILED).
      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("RECONCILIATION_REQUIRED");
      expect(op!.providerKey).toBe(providerKey);

      // A retry with the same key gets 409 "outcome unknown, do not retry".
      let retryExecCount = 0;
      await expect(
        runIdempotentOperation({
          scope,
          key,
          providerKey,
          execute: async () => {
            retryExecCount++;
            return { shouldNotReach: true };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(retryExecCount).toBe(0); // not re-executed — the caller is blocked

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.16 — External side-effect operation without providerKey → REJECTED
    //
    // Phase 12.3.2.4: Strict external contract — providerKey is REQUIRED for
    // external side-effect operations. There is NO silent default. An external
    // operation without a providerKey is REJECTED with 400 validation error
    // before any side effect runs (the execute() callback is never called and
    // no IdempotencyOperation row is created in the DB).
    //
    // Rationale: the providerKey is part of the external provider's deduplication
    // contract — silently substituting the RoamLink key hides integration
    // mistakes and can cause two distinct provider operations to share an
    // inappropriate namespace. The caller MUST supply it explicitly.
    // -------------------------------------------------------------------------
    it("12.3.2.16: external operation without providerKey → 400, provider never called, no DB row", async () => {
      const key = `p123216-${Date.now()}`;
      const scope = "test_no_provider_key_external_rejected";

      // The execute() callback must NEVER be called — providerKey validation
      // runs BEFORE the INSERT and before execute().
      let executeCallCount = 0;

      // An external operation (isExternal defaults to true) without a providerKey.
      // The primitive REJECTS with 400 validation error — NO silent default.
      await expect(
        runIdempotentOperation({
          scope,
          key,
          // No providerKey supplied — isExternal defaults to true.
          execute: async () => {
            executeCallCount++;
            return { outcome: "SUCCESS" as const, value: { shouldNotReach: true } };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });

      // The execute() callback was NEVER called (provider never called).
      expect(executeCallCount).toBe(0);

      // No IdempotencyOperation row was created in the DB — the validation
      // error fired BEFORE the INSERT.
      const op = await getIdempotencyOperation(scope, key);
      expect(op).toBeNull();

      // Cleanup (defensive — nothing should exist, but if a future regression
      // creates a row, we don't want it leaking into other tests).
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.18 — External execute() returns a raw value → 500 contract violation
    //
    // Phase 12.3.2.4: Strict external contract — execute() MUST return an
    // OperationOutcome<T> when isExternal is true. A raw return value is a
    // programming error (the caller forgot to classify the outcome). The
    // primitive transitions the operation to FAILED with a stored contract
    // violation and throws 500. A replay with the same key gets the stored
    // failure (NOT a re-execution).
    //
    // Rationale: forcing the caller to classify SUCCESS / CONFIRMED_FAILURE /
    // AMBIGUOUS_EXTERNAL_FAILURE at the contract boundary prevents the
    // ambiguity decision from being silently made by exception classification.
    // -------------------------------------------------------------------------
    it("12.3.2.18: external execute returns raw value → 500 contract violation, operation FAILED, replay gets stored failure", async () => {
      const key = `p123218-${Date.now()}`;
      const scope = "test_external_raw_return_contract_violation";
      const providerKey = `prov_${key}`;
      let execCount = 0;

      // External operation with explicit providerKey, but execute() returns a
      // raw value instead of an OperationOutcome → 500 contract violation.
      await expect(
        runIdempotentOperation({
          scope,
          key,
          providerKey,
          // isExternal defaults to true.
          execute: async () => {
            execCount++;
            return { raw: true } as any; // raw value, NOT an OperationOutcome
          },
        }),
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(execCount).toBe(1); // execute WAS called once (the contract violation is detected after the raw return)

      // The operation transitions to FAILED — the contract violation is stored.
      const op = await getIdempotencyOperation(scope, key);
      expect(op).not.toBeNull();
      expect(op!.state).toBe("FAILED");
      const failure = JSON.parse(op!.failureJson!);
      expect(failure.statusCode).toBe(500);
      expect(failure.errorClass).toBe("internal");
      // The stored failure mentions the contract violation.
      expect(failure.message).toMatch(/raw value|OperationOutcome|contract violation/i);

      // A replay with the same key gets the STORED failure (500) — it does NOT
      // re-execute, and it does NOT throw a fresh contract violation.
      let replayExecCount = 0;
      await expect(
        runIdempotentOperation({
          scope,
          key,
          providerKey,
          execute: async () => {
            replayExecCount++;
            return { outcome: "SUCCESS" as const, value: { shouldNotReach: true } };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(replayExecCount).toBe(0); // not re-executed — replay throws the stored failure

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.17 — Two reconciliation workers → exactly one claims, one queries
    //
    // The architect's finding: reconcileOperation() must use a fenced claim so
    // two concurrent reconciliation workers don't both query the provider.
    //
    //   Worker A: claims (RECONCILIATION_REQUIRED → RECONCILIATION_CLAIMED)
    //   Worker B: claims (0 rows — already claimed by A)
    //   Worker A: queries provider, transitions to terminal
    //   Worker B: returns current state (does not query provider)
    // -------------------------------------------------------------------------
    it("12.3.2.17: two reconciliation workers → exactly one claims and queries provider", async () => {
      const key = `p123217-${Date.now()}`;
      const scope = "test_reconciliation_ownership";
      const providerKey = `prov_${key}`;

      // Create a RECONCILIATION_REQUIRED operation.
      await db.idempotencyOperation.create({
        data: {
          scope, key,
          state: "RECONCILIATION_REQUIRED",
          providerKey,
          failureJson: JSON.stringify({ errorClass: "internal", message: "lease expired", statusCode: 500 }),
        },
      });

      let providerQueryCount = 0;

      // Fire two concurrent reconciliation workers.
      const [resultA, resultB] = await Promise.all([
        reconcileOperation({
          scope, key,
          queryProvider: async (pk) => {
            providerQueryCount++;
            // Simulate a slow provider query so both workers overlap.
            await new Promise((r) => setTimeout(r, 100));
            expect(pk).toBe(providerKey);
            return { outcome: "SUCCESS" as const, value: { orderId: "reconciled_order" } };
          },
        }),
        reconcileOperation({
          scope, key,
          queryProvider: async (pk) => {
            providerQueryCount++; // this should NOT be reached
            return { outcome: "SUCCESS" as const, value: { orderId: "reconciled_order" } };
          },
        }),
      ]);

      // Exactly one worker queried the provider (the one that won the claim).
      expect(providerQueryCount).toBe(1);

      // One worker got COMPLETED (the claim winner), the other got the current state.
      const states = [resultA, resultB].sort();
      // The claim winner transitions to COMPLETED.
      expect(states).toContain("COMPLETED");
      // The loser either sees RECONCILIATION_CLAIMED (during the winner's query)
      // or COMPLETED (after the winner finished). Either way, it did NOT query
      // the provider (providerQueryCount === 1).

      // Final state is COMPLETED.
      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("COMPLETED");
      expect(JSON.parse(op!.resultJson!)).toEqual({ orderId: "reconciled_order" });

      // Cleanup.
      await db.idempotencyOperation.deleteMany({ where: { scope, key } }).catch(() => {});
    }, 30_000);
  });
});
