/**
 * Phase 12.4.4d — Test Isolation Integrity (DB-backed)
 *
 * Proves that the canonical regression suite is:
 *   - deterministic
 *   - order-independent
 *   - isolated
 *   - free of leaked DB events/decisions/sessions
 *   - free of hidden dependence on execution order
 *
 * The architectural rule:
 *   "A test suite that is green only when tests are run in isolation is NOT green."
 *
 * Background:
 *   The original Phase 9.5.1 A1 test used `processPendingEvents(10, "worker-name")`
 *   — the GLOBAL worker primitive that claims the oldest pending event globally.
 *   Prior tests (Phase 11.x, Phase 12.x) leak `MEASUREMENT_RECEIVED` events via
 *   `executeAction`'s `emitReobserveRequest` path. Those events carry
 *   `subjectId: null, sessionId: <real>`, so the test cleanup that filtered by
 *   `subjectId: user.id` MISSED them. The leaked events filled the worker's
 *   limit=10 budget before the test's own INTENT_CHANGED event was reached,
 *   causing `expect(decision).not.toBeNull()` to fail intermittently.
 *
 * Fix:
 *   1. Production: Added `processPendingEventsForSubject(subjectId, limit?, workerId?)`
 *      and an optional `filter` parameter on `processOneEvent` / `processPendingEvents`.
 *      This forwards a `{ subjectId }` (or `{ sessionId }`, `{ resourceId }`) filter
 *      to `claimReevaluationEvent`'s atomic WHERE guard — the filter is enforced
 *      at the DB level, not in application code.
 *   2. Tests: Replaced global `processPendingEvents(...)` calls with subject-scoped
 *      `processPendingEventsForSubject(subjectId, ...)` for INTENT_CHANGED events.
 *      Resource-scoped `processPendingEvents(N, "worker", { resourceId })` for
 *      RESOURCE_DEGRADED/RESOURCE_RECOVERED events.
 *   3. Cleanup: Added `sessionId`-based `reevaluationEvent.deleteMany` companion
 *      to every existing `subjectId`-based delete. The subject filter catches
 *      INTENT_CHANGED events (subjectId = user.id). The session filter catches
 *      MEASUREMENT_RECEIVED events (subjectId = null, sessionId = session.id).
 *
 * Adversarial tests:
 *   12.4.4d.1: Phase 11.2-like state leak (MEASUREMENT_RECEIVED with subjectId=null)
 *              followed by Phase 9.5.1 A1 logic → A1 passes deterministically.
 *   12.4.4d.2: Phase 9.5.1 A1 logic followed by Phase 11.2-like state → both pass.
 *   12.4.4d.3: Run A1 multiple times sequentially → deterministic result.
 *   12.4.4d.4: Two unrelated pending INTENT_CHANGED events exist (different subjects)
 *              → processing the test's event does not consume the unrelated event.
 *   12.4.4d.5: Unrelated pending event exists from another subject
 *              → test's worker cannot accidentally process it.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { mockConnectivityProvider } from "@/lib/connectivity";
import type { ConnectivityEntitlementInput, ProviderResourceBindingInput } from "@/lib/connectivity/adapter";
import { createSession } from "@/lib/control-plane/session-manager";
import { makeDecision } from "@/lib/control-plane/decision-engine";
import { createAction, executeAction } from "@/lib/control-plane/action-executor";
import { createOrUpdatePolicy } from "@/lib/control-plane/policy-engine";
import { createIntent } from "@/lib/control-plane/intent-service";
import {
  processPendingEventsForSubject,
  processPendingEvents,
  processOneEvent,
} from "@/lib/control-plane/reevaluation";

type Fixture = {
  userId: string;
  tenantId: string;
  resourceAId: string;
  resourceBId: string;
  entitlementId: string;
  providerInstanceId: string;
  sessionId: string;
  offerWithinId: string;
  offerOverId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(suffix: string): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `p1244d-${suffix}-${Date.now()}@test.roamlink`;
  const slug = `p1244d-${suffix}-${Date.now().toString(36)}`;

  const user = await db.user.create({
    data: { email, name: "P1244d User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const subjectId = user.id;

  const tenant = await db.tenant.create({ data: { name: `P1244d ${slug}`, slug, status: "active" } });
  const starterPlan = await db.saaasPlan.findFirst({ where: { name: "starter" } });
  if (!starterPlan) throw new Error("starter plan not found");
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, saaasPlanId: starterPlan.id, status: "active", billingCycle: "monthly", currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  const capType = "INTERNET";
  let cc = await db.connectivityCapability.findUnique({ where: { type: capType } });
  if (!cc) cc = await db.connectivityCapability.create({ data: { type: capType, displayName: "Internet", description: "" } });

  const pi = await db.connectivityProviderInstance.create({ data: { tenantId: tenant.id, providerType: "mock", name: `P1244d ${slug}`, status: "active", configuration: JSON.stringify({}) } });
  const ent = await db.connectivityEntitlement.create({ data: { tenantId: tenant.id, subscriptionId: subscription.id, capabilityId: cc.id, status: "ACTIVE", capabilitySet: JSON.stringify({ downloadMbps: 500 }), validFrom: new Date(), userId: subjectId } });

  const capA = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 500, typicalLatencyMs: 20 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.92, status: "active" } });
  const resA = await db.protocolResource.create({ data: { capabilityId: capA.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "A" }), capacity: JSON.stringify({ totalBandwidthMbps: 500 }), state: "AVAILABLE" } });
  const capB = await db.protocolCapability.create({ data: { tenantId: tenant.id, providerInstanceId: pi.id, type: "INTERNET", providerType: "mock", technicalSpec: JSON.stringify({ downloadMbps: 300, typicalLatencyMs: 10 }), coverage: JSON.stringify({ countries: ["GH"] }), reliability: 0.9, status: "active" } });
  const resB = await db.protocolResource.create({ data: { capabilityId: capB.id, providerInstanceId: pi.id, identifiers: JSON.stringify({ id: "B" }), capacity: JSON.stringify({ totalBandwidthMbps: 300 }), state: "AVAILABLE" } });

  const entInput: ConnectivityEntitlementInput = {
    id: ent.id, tenantId: tenant.id, subscriptionId: subscription.id, status: "ACTIVE",
    capabilityType: "INTERNET", capabilitySet: JSON.parse(ent.capabilitySet),
    policy: null, validFrom: ent.validFrom, validUntil: null,
  };
  const prA = await mockConnectivityProvider.provision({ entitlement: entInput, binding: { id: "b", entitlementId: ent.id, providerType: "mock", providerResourceId: null, providerMetadata: null, status: "UNBOUND", provisioningState: null, providerInstanceId: pi.id, providerInstanceConfiguration: null } as ProviderResourceBindingInput });
  const bA = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prA.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resA.id }, data: { providerBindingId: bA.id } });
  const prB = await mockConnectivityProvider.provision({ entitlement: entInput, binding: { id: "b2", entitlementId: ent.id, providerType: "mock", providerResourceId: null, providerMetadata: null, status: "UNBOUND", provisioningState: null, providerInstanceId: pi.id, providerInstanceConfiguration: null } as ProviderResourceBindingInput });
  const bB = await db.providerResourceBinding.create({ data: { entitlementId: ent.id, providerType: "mock", resourceType: "hotspot_user", providerResourceId: prB.providerResourceId, providerMetadata: JSON.stringify({}), status: "BOUND", provisioningState: "COMPLETED", providerInstanceId: pi.id } });
  await db.protocolResource.update({ where: { id: resB.id }, data: { providerBindingId: bB.id } });

  const offerWithin = await db.connectivityOffer2.create({
    data: {
      tenantId: tenant.id, capabilityType: "INTERNET", providerType: "mock",
      spec: JSON.stringify({ downloadMbps: 500, uploadMbps: 100, dataLimitBytes: 5000000000, validityDays: 30, allowedCountries: ["GH"] }),
      coverage: JSON.stringify({ countries: ["GH"] }),
      wholesalePriceMinor: 200, customerPriceMinor: 300, currency: "USD", status: "active", reliabilityScore: 0.92,
    },
  });
  const offerOver = await db.connectivityOffer2.create({
    data: {
      tenantId: tenant.id, capabilityType: "INTERNET", providerType: "mock",
      spec: JSON.stringify({ downloadMbps: 1000, uploadMbps: 200, dataLimitBytes: 10000000000, validityDays: 30, allowedCountries: ["GH"] }),
      coverage: JSON.stringify({ countries: ["GH"] }),
      wholesalePriceMinor: 700, customerPriceMinor: 1000, currency: "USD", status: "active", reliabilityScore: 0.95,
    },
  });

  await createOrUpdatePolicy({ subjectId, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });
  const session = await createSession({ subjectId, entitlementId: ent.id });

  // ACTIVATE A
  const decision = await makeDecision({ tenantId: tenant.id, subjectId, sessionId: session.id });
  const action = await createAction({ sessionId: session.id, decisionId: decision.decisionId, type: "ACTIVATE", targetResourceId: decision.targetResourceId!, idempotencyKey: `p1244d-${session.id}` });
  await executeAction(action.id);

  const cleanup = async () => {
    await db.connectivityIntentRecord.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.connectivityAction.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityDecision.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.connectivityMeasurement.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    // Phase 12.4.4d: Delete events for BOTH subject AND session.
    await db.reevaluationEvent.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.reevaluationEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
    await db.resourceHealth.deleteMany({ where: { resourceId: { in: [resA.id, resB.id] } } }).catch(() => {});
    await db.connectivitySession.deleteMany({ where: { id: session.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId } }).catch(() => {});
    await db.protocolResource.deleteMany({ where: { id: { in: [resA.id, resB.id] } } }).catch(() => {});
    await db.protocolCapability.deleteMany({ where: { id: { in: [capA.id, capB.id] } } }).catch(() => {});
    await db.providerResourceBinding.deleteMany({ where: { id: { in: [bA.id, bB.id] } } }).catch(() => {});
    await db.connectivityOffer2.deleteMany({ where: { id: { in: [offerWithin.id, offerOver.id] } } }).catch(() => {});
    await db.connectivityEntitlement.deleteMany({ where: { id: ent.id } }).catch(() => {});
    await db.connectivityProviderInstance.deleteMany({ where: { id: pi.id } }).catch(() => {});
    await db.tenantSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => {});
    await db.tenant.deleteMany({ where: { id: tenant.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return {
    userId: user.id,
    tenantId: tenant.id,
    resourceAId: resA.id,
    resourceBId: resB.id,
    entitlementId: ent.id,
    providerInstanceId: pi.id,
    sessionId: session.id,
    offerWithinId: offerWithin.id,
    offerOverId: offerOver.id,
    cleanup,
  };
}

/**
 * Helper: emit a "leaked" MEASUREMENT_RECEIVED event with subjectId=null and
 * a real sessionId (mimicking the exact pattern emitReobserveRequest produces
 * when executeAction runs in a prior test).
 */
async function emitLeakedMeasurementReceived(sessionId: string, resourceId: string): Promise<string> {
  const event = await db.reevaluationEvent.create({
    data: {
      type: "MEASUREMENT_RECEIVED",
      resourceId,
      sessionId,
      subjectId: null, // ← exactly what emitReobserveRequest emits
      payload: JSON.stringify({ reobserve: true, resourceId, sessionId, reason: "post-action-reobservation" }),
      idempotencyKey: `leak-${sessionId}-${resourceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      state: "PENDING",
    },
  });
  return event.id;
}

describe("Phase 12.4.4d — Test Isolation Integrity (DB-backed)", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await setupFixture("main"); }, 120_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 120_000);

  // =========================================================================
  // 12.4.4d.1 — Phase 11.2-like state leak followed by Phase 9.5.1 A1 logic
  //
  // Mimics the original failure: a prior test (Phase 11.2) leaks
  // MEASUREMENT_RECEIVED events with subjectId=null. The subject-scoped worker
  // must NOT consume them — only the test's own INTENT_CHANGED event (for the
  // test's subjectId) is claimed and processed.
  // =========================================================================
  it("12.4.4d.1: leaked MEASUREMENT_RECEIVED events (subjectId=null) do not break A1 — subject-scoped worker skips them", async () => {
    // 1. Emit several leaked events (mimicking Phase 11.2's executeAction calls
    //    that left MEASUREMENT_RECEIVED events with subjectId=null).
    const leakIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = await emitLeakedMeasurementReceived(fx.sessionId, fx.resourceAId);
      leakIds.push(id);
    }
    // Verify the leaks are PENDING in the global queue.
    const pendingLeaks = await db.reevaluationEvent.count({
      where: { id: { in: leakIds }, state: "PENDING" },
    });
    expect(pendingLeaks).toBe(12);

    // 2. Create the test's own INTENT_CHANGED event for fx.userId.
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "cheap connectivity under $5 (12.4.4d.1)",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 500,
    });

    // 3. Process via the SUBJECT-SCOPED worker. It must claim ONLY events with
    //    subjectId = fx.userId. The 12 leaked events (subjectId=null) must NOT
    //    be claimed by this worker.
    const result = await processPendingEventsForSubject(fx.userId, 10, "p1244d-1-worker");
    expect(result.processed).toBeGreaterThanOrEqual(1);

    // 4. The test's decision was created (not skipped due to leaked events).
    const decision = await db.connectivityDecision.findFirst({
      where: { intentId: intent.intentId },
      orderBy: { createdAt: "desc" },
      select: { id: true, reasonCodes: true, constraintsSatisfied: true, constraintsViolated: true },
    });
    expect(decision).not.toBeNull();
    const codes = JSON.parse(decision!.reasonCodes || "[]");
    expect(codes).toContain("BUDGET_CONSTRAINT");

    // 5. The 12 leaked events are STILL PENDING — they were NOT consumed by the
    //    subject-scoped worker. They remain in the global queue for the global
    //    worker (or another scoped worker) to process later.
    const stillPending = await db.reevaluationEvent.count({
      where: { id: { in: leakIds }, state: "PENDING" },
    });
    expect(stillPending).toBe(12);

    // Cleanup: delete the leaked events (mimicking what a proper cleanup would do).
    await db.reevaluationEvent.deleteMany({ where: { id: { in: leakIds } } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 12.4.4d.2 — Phase 9.5.1 A1 logic followed by Phase 11.2-like leak
  //
  // Reverse order: A1 runs FIRST, then leaked events appear. A1 must still
  // pass deterministically. The leaked events from the SECOND step must not
  // retroactively affect A1's decision (which was already persisted).
  // =========================================================================
  it("12.4.4d.2: A1 runs first, then leaked events appear — A1 result is stable", async () => {
    // 1. A1 runs first — create intent, process via subject-scoped worker.
    const intent = await createIntent({
      subjectId: fx.userId,
      rawText: "cheap connectivity under $5 (12.4.4d.2)",
      capabilityType: "INTERNET",
      mode: "AUTOMATIC",
      maxPriceMinor: 500,
    });
    const result = await processPendingEventsForSubject(fx.userId, 10, "p1244d-2-worker");
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const decisionBeforeLeak = await db.connectivityDecision.findFirst({
      where: { intentId: intent.intentId },
      orderBy: { createdAt: "desc" },
      select: { id: true, reasonCodes: true, constraintsSatisfied: true, constraintsViolated: true },
    });
    expect(decisionBeforeLeak).not.toBeNull();
    const codesBefore = JSON.parse(decisionBeforeLeak!.reasonCodes || "[]");
    expect(codesBefore).toContain("BUDGET_CONSTRAINT");

    // 2. AFTER A1 completes, leaked events appear (mimicking a later test that
    //    emits MEASUREMENT_RECEIVED events with subjectId=null).
    const leakIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = await emitLeakedMeasurementReceived(fx.sessionId, fx.resourceAId);
      leakIds.push(id);
    }

    // 3. Re-read A1's decision — it must be UNCHANGED. Leaked events after the
    //    fact cannot retroactively invalidate A1's decision.
    const decisionAfterLeak = await db.connectivityDecision.findUnique({
      where: { id: decisionBeforeLeak!.id },
      select: { reasonCodes: true, constraintsSatisfied: true, constraintsViolated: true },
    });
    expect(decisionAfterLeak?.reasonCodes).toBe(decisionBeforeLeak!.reasonCodes);
    expect(decisionAfterLeak?.constraintsSatisfied).toBe(decisionBeforeLeak!.constraintsSatisfied);
    expect(decisionAfterLeak?.constraintsViolated).toBe(decisionBeforeLeak!.constraintsViolated);

    // Cleanup.
    await db.reevaluationEvent.deleteMany({ where: { id: { in: leakIds } } }).catch(() => {});
  }, 60_000);

  // =========================================================================
  // 12.4.4d.3 — Run A1 multiple times sequentially → deterministic result
  //
  // The same A1 logic, run N times in the same test, must produce the same
  // decision (BUDGET_CONSTRAINT present) every time. No nondeterminism from
  // accumulated state.
  // =========================================================================
  it("12.4.4d.3: A1 run 5 times sequentially — deterministic BUDGET_CONSTRAINT every time", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const intent = await createIntent({
        subjectId: fx.userId,
        rawText: `cheap connectivity under $5 (12.4.4d.3 run ${i})`,
        capabilityType: "INTERNET",
        mode: "AUTOMATIC",
        maxPriceMinor: 500,
      });
      const result = await processPendingEventsForSubject(fx.userId, 10, `p1244d-3-worker-run-${i}`);
      expect(result.processed).toBeGreaterThanOrEqual(1);

      const decision = await db.connectivityDecision.findFirst({
        where: { intentId: intent.intentId },
        orderBy: { createdAt: "desc" },
        select: { reasonCodes: true },
      });
      expect(decision).not.toBeNull();
      const codes = JSON.parse(decision!.reasonCodes || "[]");
      const hasBudgetConstraint = codes.includes("BUDGET_CONSTRAINT");
      results.push(hasBudgetConstraint);

      // Per-iteration cleanup: delete this iteration's intent + decision + event.
      await db.connectivityDecision.deleteMany({ where: { intentId: intent.intentId } }).catch(() => {});
      await db.connectivityIntentRecord.deleteMany({ where: { intentId: intent.intentId } }).catch(() => {});
      await db.reevaluationEvent.deleteMany({ where: { subjectId: fx.userId, type: "INTENT_CHANGED" } }).catch(() => {});
    }
    // All 5 runs must include BUDGET_CONSTRAINT.
    expect(results).toEqual([true, true, true, true, true]);
  }, 120_000);

  // =========================================================================
  // 12.4.4d.4 — Two unrelated pending INTENT_CHANGED events (different subjects)
  //
  // Two pending INTENT_CHANGED events exist for DIFFERENT subjects. Processing
  // the test's event (for subject A) must NOT consume subject B's event.
  // =========================================================================
  it("12.4.4d.4: two unrelated pending INTENT_CHANGED events (different subjects) — subject-scoped worker does not consume the other subject's event", async () => {
    // 1. Create a SECOND fixture (subject B) with its own intent + event.
    const fxB = await setupFixture("b");

    try {
      const intentA = await createIntent({
        subjectId: fx.userId,
        rawText: "subject A intent (12.4.4d.4)",
        capabilityType: "INTERNET",
        mode: "AUTOMATIC",
        maxPriceMinor: 500,
      });
      const intentB = await createIntent({
        subjectId: fxB.userId,
        rawText: "subject B intent (12.4.4d.4)",
        capabilityType: "INTERNET",
        mode: "AUTOMATIC",
        maxPriceMinor: 500,
      });

      // 2. Verify BOTH subjects have a PENDING INTENT_CHANGED event.
      const pendingA = await db.reevaluationEvent.findFirst({
        where: { subjectId: fx.userId, type: "INTENT_CHANGED", state: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      const pendingB = await db.reevaluationEvent.findFirst({
        where: { subjectId: fxB.userId, type: "INTENT_CHANGED", state: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      expect(pendingA).not.toBeNull();
      expect(pendingB).not.toBeNull();
      expect(pendingA!.id).not.toBe(pendingB!.id);

      // 3. Process ONLY subject A's events via the subject-scoped worker.
      const resultA = await processPendingEventsForSubject(fx.userId, 10, "p1244d-4-worker-A");
      expect(resultA.processed).toBeGreaterThanOrEqual(1);

      // 4. Subject A's decision was created.
      const decisionA = await db.connectivityDecision.findFirst({
        where: { intentId: intentA.intentId },
        orderBy: { createdAt: "desc" },
        select: { reasonCodes: true },
      });
      expect(decisionA).not.toBeNull();
      const codesA = JSON.parse(decisionA!.reasonCodes || "[]");
      expect(codesA).toContain("BUDGET_CONSTRAINT");

      // 5. Subject B's event is STILL PENDING — the subject-A worker did NOT
      //    consume it.
      const stillPendingB = await db.reevaluationEvent.findFirst({
        where: { id: pendingB!.id },
        select: { state: true },
      });
      expect(stillPendingB?.state).toBe("PENDING");

      // 6. Subject B's decision was NOT created yet (its event wasn't processed).
      const decisionB = await db.connectivityDecision.findFirst({
        where: { intentId: intentB.intentId },
        orderBy: { createdAt: "desc" },
      });
      expect(decisionB).toBeNull();

      // 7. Now process subject B's events via the subject-scoped worker.
      const resultB = await processPendingEventsForSubject(fxB.userId, 10, "p1244d-4-worker-B");
      expect(resultB.processed).toBeGreaterThanOrEqual(1);

      // 8. Subject B's decision is now created.
      const decisionBAfter = await db.connectivityDecision.findFirst({
        where: { intentId: intentB.intentId },
        orderBy: { createdAt: "desc" },
        select: { reasonCodes: true },
      });
      expect(decisionBAfter).not.toBeNull();
      const codesB = JSON.parse(decisionBAfter!.reasonCodes || "[]");
      expect(codesB).toContain("BUDGET_CONSTRAINT");
    } finally {
      await fxB.cleanup();
    }
  }, 120_000);

  // =========================================================================
  // 12.4.4d.5 — Unrelated pending event from another subject — test's worker
  //             cannot accidentally process it (filter is enforced at DB level)
  //
  // An unrelated INTENT_CHANGED event exists for a DIFFERENT subject. The test's
  // subject-scoped worker (filter = { subjectId: fx.userId }) must NOT be able
  // to claim it. The filter is enforced at the DB level via Prisma's atomic
  // WHERE guard — not in application code.
  // =========================================================================
  it("12.4.4d.5: unrelated pending event from another subject — subject-scoped worker cannot process it", async () => {
    // 1. Create an unrelated event for a different subject (with a subjectId
    //    that is NOT fx.userId — the worker's filter subject).
    const unrelatedSubjectId = `unrelated-subject-${Date.now()}`;
    const unrelatedEvent = await db.reevaluationEvent.create({
      data: {
        type: "INTENT_CHANGED",
        subjectId: unrelatedSubjectId,
        resourceId: null,
        sessionId: null,
        payload: JSON.stringify({
          intentId: `unrelated-intent-${Date.now()}`,
          intentVersion: 1,
          subjectId: unrelatedSubjectId,
          deviceId: null,
          reason: "test-isolation-adversarial",
        }),
        state: "PENDING",
      },
    });

    try {
      // 2. The test's worker is scoped to fx.userId. It must NOT claim the
      //    unrelated event (which has subjectId = unrelatedSubjectId).
      //    The DB-level WHERE guard in claimReevaluationEvent enforces this.
      const result = await processPendingEventsForSubject(fx.userId, 10, "p1244d-5-worker");

      // 3. The worker may process fx.userId's own events (from prior tests in
      //    this describe block that may have left INTENT_CHANGED events). That's
      //    fine — what matters is that the unrelated event was NOT consumed.
      //    We assert: the unrelated event is STILL PENDING.

      // 4. The unrelated event is STILL PENDING — the subject-scoped worker
      //    could NOT claim it (filter enforced at DB level).
      const stillPending = await db.reevaluationEvent.findUnique({
        where: { id: unrelatedEvent.id },
        select: { state: true, claimId: true, subjectId: true },
      });
      expect(stillPending?.state).toBe("PENDING");
      expect(stillPending?.claimId).toBeNull();
      expect(stillPending?.subjectId).toBe(unrelatedSubjectId);

      // 5. Sanity: even calling processOneEvent (which is the lowest-level
      //    primitive) with the subject-scoped filter cannot claim the unrelated
      //    event.
      const workerId = `p1244d-5-direct-${Date.now()}`;
      // First, drain any fx.userId events that may exist from prior tests.
      for (let i = 0; i < 5; i++) {
        const r = await processOneEvent(workerId, { subjectId: fx.userId });
        if (!r) break;
      }
      // Now call processOneEvent again — it must return null (no more fx.userId
      // events to process). The unrelated event is STILL not claimable by this
      // subject-scoped worker.
      const drained = await processOneEvent(workerId, { subjectId: fx.userId });
      expect(drained).toBeNull();

      // The unrelated event is STILL PENDING — the subject-scoped worker
      // could NOT claim it (filter enforced at DB level).
      const stillPendingFinal = await db.reevaluationEvent.findUnique({
        where: { id: unrelatedEvent.id },
        select: { state: true, claimId: true, subjectId: true },
      });
      expect(stillPendingFinal?.state).toBe("PENDING");
      expect(stillPendingFinal?.claimId).toBeNull();
      expect(stillPendingFinal?.subjectId).toBe(unrelatedSubjectId);

      // 6. Cross-check: a DIRECT claimReevaluationEvent call with the
      //    subject-scoped filter returns null (no event available for
      //    fx.userId), even though the unrelated event IS pending globally.
      //    This proves the filter is what protects us, not the absence of
      //    claimable events.
      const { claimReevaluationEvent } = await import("@/lib/control-plane/reevaluation");
      const directClaim = await claimReevaluationEvent(`p1244d-5-direct-claim-${Date.now()}`, { subjectId: fx.userId });
      expect(directClaim).toBeNull();

      // 7. Cross-check (continued): a DIRECT claimReevaluationEvent call WITHOUT
      //    a filter would claim SOMETHING (the unrelated event is pending).
      //    We don't run the global claim here because doing so could consume
      //    OTHER pending events from prior tests, affecting their isolation.
      //    Instead, we count PENDING events globally to prove there ARE
      //    claimable events (so the subject-scoped filter returning null is
      //    a real protection, not an empty-queue artifact).
      const globalPendingCount = await db.reevaluationEvent.count({
        where: {
          OR: [
            { state: "PENDING" },
            { state: "CLAIMED", claimExpiresAt: { lt: new Date() } },
            { state: "FAILED", claimExpiresAt: { lt: new Date() } },
          ],
        },
      });
      expect(globalPendingCount).toBeGreaterThanOrEqual(1);
    } finally {
      // Cleanup the unrelated event.
      await db.reevaluationEvent.deleteMany({ where: { id: unrelatedEvent.id } }).catch(() => {});
    }
  }, 60_000);
});
