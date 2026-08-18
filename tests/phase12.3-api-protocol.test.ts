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
 *
 * The critical test is 12.3.2.2: two concurrent requests with the same key.
 * Under the prior runIdempotent() (findExisting → execute), both would execute.
 * Under the new DB-authoritative primitive, only one executes; the other
 * polls and returns the stored result.
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
        runIdempotentOperation({ scope, key, execute }),
        runIdempotentOperation({ scope, key, execute }),
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
        execute: async () => ({ orderId: "order_A" }),
      });

      // Second request with the SAME key but DIFFERENT payload → 409.
      await expect(
        runIdempotentOperation({
          scope,
          key,
          payloadHash: payloadB,
          execute: async () => ({ orderId: "order_B" }),
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.5 — failure is dead-lettered (replay throws the stored failure)
    // -------------------------------------------------------------------------
    it("12.3.2.5: execute failure → dead-lettered, replay throws the stored failure", async () => {
      const key = `p12325-${Date.now()}`;
      const scope = "test_failure";
      let execCount = 0;

      // First request fails.
      await expect(
        runIdempotentOperation({
          scope,
          key,
          execute: async () => {
            execCount++;
            throw new AppError("payment", "Card declined", 402, "Your card was declined.");
          },
        }),
      ).rejects.toMatchObject({ statusCode: 402 });
      expect(execCount).toBe(1);

      // Operation is FAILED, not COMPLETED.
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
          execute: async () => {
            execCount++;
            return { shouldNotReach: true };
          },
        }),
      ).rejects.toMatchObject({ statusCode: 402 });
      expect(execCount).toBe(1); // still 1 — no re-execution on replay
    }, 30_000);

    // -------------------------------------------------------------------------
    // 12.3.2.6 — reclaim expired IN_PROGRESS → FAILED (crashed worker recovery)
    // -------------------------------------------------------------------------
    it("12.3.2.6: reclaim expired IN_PROGRESS → FAILED (crashed worker recovery)", async () => {
      const key = `p12326-${Date.now()}`;
      const scope = "test_reclaim";

      // Create an IN_PROGRESS operation with a very short lease (already expired).
      await db.idempotencyOperation.create({
        data: {
          scope,
          key,
          state: "IN_PROGRESS",
          claimExpiresAt: new Date(Date.now() - 1000), // expired 1 second ago
        },
      });

      // Reclaim.
      const reclaimed = await reclaimExpiredIdempotencyOperations();
      expect(reclaimed).toBeGreaterThanOrEqual(1);

      // Operation is now FAILED.
      const op = await getIdempotencyOperation(scope, key);
      expect(op!.state).toBe("FAILED");
      const failure = JSON.parse(op!.failureJson!);
      expect(failure.statusCode).toBe(500);
      expect(failure.message).toMatch(/lease expired/i);

      // A future request with the same key gets the failure (not a hung poll).
      await expect(
        runIdempotentOperation({
          scope,
          key,
          execute: async () => ({ shouldNotReach: true }),
        }),
      ).rejects.toMatchObject({ statusCode: 500 });
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
        runIdempotentOperation({ scope, key, execute }),
        runIdempotentOperation({ scope, key, execute }),
        runIdempotentOperation({ scope, key, execute }),
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
  });
});
