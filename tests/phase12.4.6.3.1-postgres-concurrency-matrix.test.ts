/**
 * Phase 12.4.6.3.1 — PostgreSQL Concurrency Matrix.
 *
 * TEST CLASS: DB-AUTHORITY / DB-CONCURRENCY
 *
 * These tests MUST run on PostgreSQL. They prove the DB-authoritative
 * concurrency primitives that production depends on. SQLite is NOT a
 * substitute — these semantics differ between providers (row-level locking,
 * FOR UPDATE, conditional updateMany atomicity, unique constraint behavior).
 *
 * Matrix:
 *   12.4.6.3.1.1 — Concurrent RateLimitCounter increment: exactly N allowed.
 *   12.4.6.3.1.2 — Concurrent IdempotencyOperation claim: exactly one owner.
 *   12.4.6.3.1.3 — Concurrent session execution slot: exactly one owner.
 *   12.4.6.3.1.4 — Concurrent intent fence: stale worker cannot overwrite.
 *   12.4.6.3.1.5 — Concurrent ProviderOperationRecord recovery: exactly one owner.
 *   12.4.6.3.1.6 — Unique constraint: P2002 is correctly handled.
 *
 * Environment:
 *   - DATABASE_URL must point to PostgreSQL (Neon or local PG).
 *   - If DATABASE_TEST_URL is set, tests use the isolated test DB.
 *   - RATE_LIMIT_KEY_PER_MINUTE=5 is set below to prove rate-limit semantics
 *     with 6 requests instead of 101. This is dependency injection — the
 *     conditional updateMany primitive is identical regardless of the limit.
 *
 * Run: bun test tests/phase12.4.6.3.1-postgres-concurrency-matrix.test.ts
 */

// Set a small rate limit BEFORE importing the rate-limit module so the
// effective limit is 5/min (not the production default of 100/min). This
// proves the same DB-authoritative semantics with 6 requests.
process.env.RATE_LIMIT_KEY_PER_MINUTE = "5";
process.env.RATE_LIMIT_TENANT_PER_MINUTE = "10";
process.env.RATE_LIMIT_SENSITIVE_PER_MINUTE = "3";

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { checkRateLimit, getKeyLimitPerMinute } from "@/lib/api/rate-limit";
import { acquireSessionExecutionSlot } from "@/lib/control-plane/session-execution-slot";
import { createTenant } from "@/lib/tenant/service";
import { hashPassword } from "@/lib/security";
import {
  assertPostgres,
  cleanupTenants,
  uniqueTestSlug,
} from "./db-test-env";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  tenantId: string;
  tenantId2: string;
  userId: string;
  entitlementId: string;
  cleanup: () => Promise<void>;
};

let fx: Fixture;

async function setupFixture(): Promise<Fixture> {
  const slug = uniqueTestSlug("p124631");
  const tenant = await createTenant({
    name: `P124631 ${slug}`,
    slug,
    status: "active",
  });
  const tenant2 = await createTenant({
    name: `P124631B ${slug}`,
    slug: `b-${slug}`,
    status: "active",
  });

  const email = `p124631-${slug}@test.roamlink`;
  const user = await db.user.create({
    data: {
      email,
      name: `P124631 ${slug}`,
      passwordHash: await hashPassword("test12345"),
      role: "customer",
      emailVerified: new Date(),
    },
  });

  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found — run bun run db:seed");

  const subscription = await db.tenantSubscription.create({
    data: {
      tenantId: tenant.id,
      saaasPlanId: starterPlan.id,
      status: "active",
      billingCycle: "monthly",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
    },
  });

  let cc = await db.connectivityCapability.findUnique({ where: { type: "INTERNET" } });
  if (!cc) {
    cc = await db.connectivityCapability.create({
      data: { type: "INTERNET", displayName: "Internet", description: "" },
    });
  }

  const entitlement = await db.connectivityEntitlement.create({
    data: {
      tenantId: tenant.id,
      subscriptionId: subscription.id,
      capabilityId: cc.id,
      status: "ACTIVE",
      capabilitySet: JSON.stringify({ downloadMbps: 500 }),
      validFrom: new Date(),
      userId: user.id,
    },
  });

  const cleanup = async () => {
    // Scoped cleanup — delete only this test run's data (by tenantId).
    await cleanupTenants([tenant.id, tenant2.id]);
    // Clean up the test user.
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return {
    tenantId: tenant.id,
    tenantId2: tenant2.id,
    userId: user.id,
    entitlementId: entitlement.id,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 12.4.6.3.1 — PostgreSQL Concurrency Matrix", () => {
  beforeAll(async () => {
    assertPostgres();
    fx = await setupFixture();
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
  }, 120_000);

  // -------------------------------------------------------------------------
  // 12.4.6.3.1.1 — Concurrent RateLimitCounter increment: exactly N allowed.
  //
  // Proves: the conditional updateMany (WHERE count < limit) is DB-authoritative
  // on PostgreSQL. Two concurrent requests cannot both increment past the limit.
  // With RATE_LIMIT_KEY_PER_MINUTE=5, exactly 5 of 15 concurrent requests pass.
  // -------------------------------------------------------------------------
  it(
    "12.4.6.3.1.1: concurrent RateLimitCounter — exactly N allowed, rest denied",
    async () => {
      const limit = getKeyLimitPerMinute(); // 5 (set via env above)
      expect(limit).toBe(5);

      const apiKeyId = `matrix-key-${uniqueTestSlug("rl")}`;
      const path = "/api/v1/matrix-rate-limit";
      const totalRequests = limit + 10; // 15 requests, only 5 should pass.

      // Clean any prior counter for this scope.
      await db.rateLimitCounter
        .deleteMany({ where: { scopeId: apiKeyId } })
        .catch(() => {});

      // Fire all requests concurrently.
      const results = await Promise.all(
        Array.from({ length: totalRequests }, () =>
          checkRateLimit({
            tenantId: fx.tenantId,
            apiKeyId,
            path,
          }),
        ),
      );

      const allowed = results.filter((r) => r.allowed);
      const denied = results.filter((r) => !r.allowed);

      // EXACT assertion: exactly `limit` requests pass, no bypass under concurrency.
      expect(allowed.length).toBe(limit);
      expect(denied.length).toBe(totalRequests - limit);
      expect(denied.length).toBe(10);

      // Every denied request must report the correct scope + 0 remaining.
      for (const d of denied) {
        expect(d.remaining).toBe(0);
        expect(d.scope).toBe("key");
        expect(d.deniedScope).toBe("key");
      }

      // Cleanup.
      await db.rateLimitCounter
        .deleteMany({ where: { scopeId: apiKeyId } })
        .catch(() => {});
      await db.rateLimitCounter
        .deleteMany({ where: { scopeId: fx.tenantId } })
        .catch(() => {});
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 12.4.6.3.1.2 — Concurrent IdempotencyOperation claim: exactly one owner.
  //
  // Proves: the unique constraint on (scope, key) is DB-authoritative. When N
  // workers concurrently try to INSERT the same (scope, key), exactly one
  // succeeds and the rest get P2002 (unique constraint violation).
  // -------------------------------------------------------------------------
  it(
    "12.4.6.3.1.2: concurrent IdempotencyOperation claim — exactly one owner",
    async () => {
      const scope = `matrix-idem-${uniqueTestSlug("sc")}`;
      const key = `matrix-key-${uniqueTestSlug("k")}`;

      const workers = 8;
      let successes = 0;
      let p2002 = 0;
      let otherErrors = 0;

      // Fire N concurrent INSERTs.
      await Promise.all(
        Array.from({ length: workers }, async () => {
          try {
            await db.idempotencyOperation.create({
              data: {
                scope,
                key,
                state: "IN_PROGRESS",
                payloadHash: "deadbeef",
                tenantId: fx.tenantId,
                claimId: `claim-${Math.random().toString(36).slice(2)}`,
                claimExpiresAt: new Date(Date.now() + 60000),
                providerKey: `pk-${key}`,
              },
            });
            successes++;
          } catch (err: any) {
            if (err?.code === "P2002") {
              p2002++;
            } else {
              otherErrors++;
            }
          }
        }),
      );

      // EXACT assertion: exactly 1 success, rest are P2002.
      expect(successes).toBe(1);
      expect(p2002).toBe(workers - 1);
      expect(otherErrors).toBe(0);

      // Cleanup.
      await db.idempotencyOperation
        .deleteMany({ where: { scope, key } })
        .catch(() => {});
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 12.4.6.3.1.3 — Concurrent session execution slot: exactly one owner.
  //
  // Proves: acquireSessionExecutionSlot's fenced updateMany is DB-authoritative.
  // When N workers concurrently try to acquire the same session's slot, exactly
  // one succeeds (count=1) and the rest get count=0.
  // -------------------------------------------------------------------------
  it(
    "12.4.6.3.1.3: concurrent session execution slot — exactly one owner",
    async () => {
      const session = await db.connectivitySession.create({
        data: {
          subjectId: fx.userId,
          entitlementId: fx.entitlementId,
          state: "PLANNED",
        },
      });

      try {
        const workers = 8;
        const claimIds = Array.from(
          { length: workers },
          (_, i) => `slot-claim-${i}-${Math.random().toString(36).slice(2)}`,
        );

        // Fire N concurrent acquire calls.
        const results = await Promise.all(
          claimIds.map((cid) => acquireSessionExecutionSlot(session.id, cid)),
        );

        const acquired = results.filter((r) => r.acquired);

        // EXACT assertion: exactly 1 acquisition succeeds.
        expect(acquired.length).toBe(1);
        expect(results.length - acquired.length).toBe(workers - 1);

        // Verify the winner's claimId is stored.
        const updated = await db.connectivitySession.findUnique({
          where: { id: session.id },
          select: { executionSlotClaimId: true },
        });
        expect(updated?.executionSlotClaimId).not.toBeNull();
        expect(acquired[0]).toBeDefined();
      } finally {
        await db.connectivitySession
          .deleteMany({ where: { id: session.id } })
          .catch(() => {});
      }
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 12.4.6.3.1.4 — Concurrent intent fence: stale worker cannot overwrite.
  //
  // Proves: the (intentId, version) unique constraint prevents a stale worker
  // from overwriting a newer version. Worker A reads version=1 and creates
  // version=2. Worker B (stale) also read version=1 and tries to create
  // version=2 → P2002. Worker B cannot win.
  //
  // This is the DB-authoritative primitive that the intent-authority code
  // (Phase 11.4) relies on: a superseded intent cannot execute because the
  // version check fails atomically.
  // -------------------------------------------------------------------------
  it(
    "12.4.6.3.1.4: concurrent intent fence — stale worker cannot overwrite",
    async () => {
      const intentId = `intent-${uniqueTestSlug("fence")}`;

      try {
        // Create version 1 of the intent record.
        await db.connectivityIntentRecord.create({
          data: {
            intentId,
            subjectId: fx.userId,
            version: 1,
            status: "ACTIVE",
            payload: JSON.stringify({ capabilityType: "INTERNET" }),
          },
        });

        // Two workers both try to create version 2 concurrently.
        // The unique constraint on (intentId, version) guarantees exactly one wins.
        let successA = false;
        let successB = false;
        let p2002 = 0;

        await Promise.all([
          (async () => {
            try {
              await db.connectivityIntentRecord.create({
                data: {
                  intentId,
                  subjectId: fx.userId,
                  version: 2,
                  status: "ACTIVE",
                  payload: JSON.stringify({ capabilityType: "INTERNET", mesh: true }),
                },
              });
              successA = true;
            } catch (err: any) {
              if (err?.code === "P2002") p2002++;
            }
          })(),
          (async () => {
            try {
              await db.connectivityIntentRecord.create({
                data: {
                  intentId,
                  subjectId: fx.userId,
                  version: 2,
                  status: "ACTIVE",
                  payload: JSON.stringify({ capabilityType: "INTERNET", vpn: true }),
                },
              });
              successB = true;
            } catch (err: any) {
              if (err?.code === "P2002") p2002++;
            }
          })(),
        ]);

        // EXACT assertion: exactly one worker creates version 2.
        const totalSuccess = (successA ? 1 : 0) + (successB ? 1 : 0);
        expect(totalSuccess).toBe(1);
        expect(p2002).toBe(1);

        // Verify only one version-2 row exists.
        const v2Rows = await db.connectivityIntentRecord.findMany({
          where: { intentId, version: 2 },
        });
        expect(v2Rows.length).toBe(1);
      } finally {
        await db.connectivityIntentRecord
          .deleteMany({ where: { intentId } })
          .catch(() => {});
      }
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 12.4.6.3.1.5 — Concurrent ProviderOperationRecord recovery: exactly one owner.
  //
  // Proves: the recovery claim's fenced updateMany is DB-authoritative. When N
  // workers concurrently try to claim the same STARTED record, exactly one
  // succeeds (count=1) and the rest get count=0.
  // -------------------------------------------------------------------------
  it(
    "12.4.6.3.1.5: concurrent ProviderOperationRecord recovery — exactly one owner",
    async () => {
      // Create a STARTED ProviderOperationRecord.
      const record = await db.providerOperationRecord.create({
        data: {
          operation: "provision",
          state: "STARTED",
          tenantId: fx.tenantId,
          startedAt: new Date(Date.now() - 120_000), // 2 min ago — eligible for recovery
        },
      });

      try {
        const workers = 8;
        const now = new Date();
        const claimExpiresAt = new Date(now.getTime() + 30000);

        // Fire N concurrent recovery claims (fenced updateMany).
        const results = await Promise.all(
          Array.from({ length: workers }, (_, i) =>
            db.providerOperationRecord.updateMany({
              where: {
                id: record.id,
                state: "STARTED",
                OR: [
                  { recoveryClaimId: null },
                  { recoveryClaimExpiresAt: { lt: now } },
                ],
              },
              data: {
                recoveryClaimId: `recovery-${i}-${Math.random().toString(36).slice(2)}`,
                recoveryClaimedAt: now,
                recoveryClaimExpiresAt: claimExpiresAt,
              },
            }),
          ),
        );

        const claimed = results.filter((r) => r.count > 0);

        // EXACT assertion: exactly 1 claim succeeds.
        expect(claimed.length).toBe(1);
        expect(results.length - claimed.length).toBe(workers - 1);

        // Verify the record now has a recoveryClaimId.
        const updated = await db.providerOperationRecord.findUnique({
          where: { id: record.id },
          select: { recoveryClaimId: true },
        });
        expect(updated?.recoveryClaimId).not.toBeNull();
      } finally {
        await db.providerOperationRecord
          .deleteMany({ where: { id: record.id } })
          .catch(() => {});
      }
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 12.4.6.3.1.6 — Unique constraint: P2002 is correctly handled.
  //
  // Proves: PostgreSQL's unique constraint is enforced and Prisma surfaces it
  // as P2002. Two concurrent creates with the same unique key → exactly one
  // succeeds, the other gets P2002 with the correct field name.
  // -------------------------------------------------------------------------
  it(
    "12.4.6.3.1.6: unique constraint — P2002 is correctly surfaced",
    async () => {
      const email = `p2002-${uniqueTestSlug("u")}@test.roamlink`;
      let successA = false;
      let successB = false;
      let p2002 = 0;
      let p2002Field: string | undefined;

      await Promise.all([
        (async () => {
          try {
            await db.user.create({
              data: {
                email,
                name: "P2002 A",
                passwordHash: "x",
                role: "customer",
                emailVerified: new Date(),
              },
            });
            successA = true;
          } catch (err: any) {
            if (err?.code === "P2002") {
              p2002++;
              p2002Field = err?.meta?.target?.[0];
            }
          }
        })(),
        (async () => {
          try {
            await db.user.create({
              data: {
                email,
                name: "P2002 B",
                passwordHash: "x",
                role: "customer",
                emailVerified: new Date(),
              },
            });
            successB = true;
          } catch (err: any) {
            if (err?.code === "P2002") {
              p2002++;
              p2002Field = err?.meta?.target?.[0];
            }
          }
        })(),
      ]);

      // EXACT assertion: exactly one create succeeds, the other gets P2002.
      const totalSuccess = (successA ? 1 : 0) + (successB ? 1 : 0);
      expect(totalSuccess).toBe(1);
      expect(p2002).toBe(1);
      // The P2002 error should identify the `email` field as the constraint target.
      expect(p2002Field).toBe("email");

      // Verify only one row exists with that email.
      const rows = await db.user.findMany({ where: { email } });
      expect(rows.length).toBe(1);

      // Cleanup.
      await db.user.deleteMany({ where: { email } }).catch(() => {});
    },
    120_000,
  );
});
