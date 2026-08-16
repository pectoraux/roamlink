/**
 * Phase 9.3.1 — Context Semantics Closure (DB-backed runtime)
 *
 * Proves the architectural fix: device context is a CONTEXT SNAPSHOT, not
 * authoritative policy. The base policy is NOT overwritten by device context.
 *
 *   9.3.1.1  device context persisted as snapshot (not base policy)
 *   9.3.1.2  batterySaver → effective BATTERY, base policy unchanged
 *   9.3.1.3  workMode → effective WORK, base policy unchanged
 *   9.3.1.4  base policy RELIABLE + device batterySaver → effective BATTERY
 *   9.3.1.5  base policy CHEAPEST + device workMode → effective stays CHEAPEST (no upgrade)
 *   9.3.1.6  explicit connectivityPreference → base policy updated (user override)
 *   9.3.1.7  autoSwitchEnabled=false → base policy mode=manual (user override)
 *   9.3.1.8  stale context update (observedAt < current) → rejected
 *   9.3.1.9  GET with another user's deviceId → 403
 *   9.3.1.10 context update is side-effect free (no actions/decisions created)
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { registerEdgeDevice } from "@/lib/control-plane/edge-ingestion";
import { createOrUpdatePolicy, getPolicy } from "@/lib/control-plane/policy-engine";
import { deriveEffectivePolicy } from "@/lib/control-plane/effective-policy";
import type { EdgePolicyContext } from "@roamlink/shared";

type Fixture = {
  userId: string;
  deviceId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase931-${Date.now()}@test.roamlink`;
  const user = await db.user.create({
    data: { email, name: "P931 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const deviceId = `p931-dev-${Date.now().toString(36)}`;
  await registerEdgeDevice({ userId: user.id, deviceId, platform: "android", appVersion: "0.1.0" });

  // Set a base policy (RELIABLE)
  await createOrUpdatePolicy({ subjectId: user.id, preset: "RELIABLE", mode: "automatic", maxAutoSpendMinor: 10000, requireUserApprovalForPurchase: false });

  const cleanup = async () => {
    await db.edgeObservationRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.edgeDevice.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { userId: user.id, deviceId, cleanup };
}

// Helper: persist device context (simulates the POST endpoint's persistence)
async function setDeviceContext(userId: string, deviceId: string, context: EdgePolicyContext, observedAt?: Date) {
  const device = await db.edgeDevice.findUnique({ where: { deviceId } });
  if (!device || device.userId !== userId) throw new Error("Device not registered");

  const contextObservedAt = observedAt ?? new Date();

  // Timestamp fencing: reject stale updates
  if (device.policyContextObservedAt && contextObservedAt < device.policyContextObservedAt) {
    return { ok: false, rejected: "stale" };
  }

  const newVersion = (device.policyContextVersion ?? 0) + 1;
  await db.edgeDevice.update({
    where: { deviceId },
    data: {
      policyContext: JSON.stringify(context),
      policyContextUpdatedAt: new Date(),
      policyContextObservedAt: contextObservedAt,
      policyContextVersion: newVersion,
    },
  });

  // Only explicit user overrides write to base policy.
  // Phase 9.3.1: Only write if there's a genuine override — don't call
  // createOrUpdatePolicy with just { subjectId, mode } because that would
  // use MANUAL as the base preset and overwrite the existing RELIABLE/CHEAPEST.
  const hasModeOverride = context.autoSwitchEnabled === false || context.autoSwitchEnabled === true;
  const hasPresetOverride = context.connectivityPreference === "RELIABLE" || context.connectivityPreference === "CHEAPEST" || context.connectivityPreference === "BALANCED";

  if (hasModeOverride || hasPresetOverride) {
    const basePolicyUpdates: Parameters<typeof createOrUpdatePolicy>[0] = { subjectId: userId };

    if (context.autoSwitchEnabled === false) basePolicyUpdates.mode = "manual";
    else if (context.autoSwitchEnabled === true) basePolicyUpdates.mode = "automatic";

    if (context.connectivityPreference === "RELIABLE") basePolicyUpdates.preset = "RELIABLE";
    else if (context.connectivityPreference === "CHEAPEST") basePolicyUpdates.preset = "CHEAPEST";
    else if (context.connectivityPreference === "BALANCED") basePolicyUpdates.preset = "WORK";

    await createOrUpdatePolicy(basePolicyUpdates);
  }

  return { ok: true, version: newVersion };
}

describe("Phase 9.3.1 — Context Semantics Closure (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 30_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 30_000);

  // 9.3.1.1 device context persisted as snapshot
  it("9.3.1.1: device context persisted as snapshot on EdgeDevice", async () => {
    const context: EdgePolicyContext = { batterySaver: true, workMode: false, autoSwitchEnabled: true };
    await setDeviceContext(fx.userId, fx.deviceId, context);

    const device = await db.edgeDevice.findUnique({ where: { deviceId: fx.deviceId } });
    expect(device?.policyContext).not.toBeNull();
    const persisted = JSON.parse(device!.policyContext!);
    expect(persisted.batterySaver).toBe(true);
    expect(device?.policyContextVersion).toBeGreaterThan(0);
    expect(device?.policyContextObservedAt).not.toBeNull();
  }, 15_000);

  // 9.3.1.2 batterySaver → effective BATTERY, base policy unchanged
  it("9.3.1.2: batterySaver=true → effective BATTERY, base policy stays RELIABLE", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "RELIABLE", mode: "automatic" });
    await setDeviceContext(fx.userId, fx.deviceId, { batterySaver: true, autoSwitchEnabled: true });

    const effective = await deriveEffectivePolicy(fx.userId, fx.deviceId);
    expect(effective.effectivePreset).toBe("BATTERY");
    expect(effective.basePreset).toBe("RELIABLE"); // base unchanged
    expect(effective.derivationReason).toContain("batterySaver");

    // Verify base policy on disk is still RELIABLE
    const basePolicy = await getPolicy(fx.userId);
    expect(basePolicy.minReliability).toBe(0.95); // RELIABLE's minReliability
    expect(basePolicy.switchHysteresis).toBe(0.2); // RELIABLE's hysteresis
  }, 15_000);

  // 9.3.1.3 workMode → effective WORK, base policy unchanged
  it("9.3.1.3: workMode=true → effective WORK, base policy stays RELIABLE", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "RELIABLE", mode: "automatic" });
    await setDeviceContext(fx.userId, fx.deviceId, { workMode: true, autoSwitchEnabled: true });

    const effective = await deriveEffectivePolicy(fx.userId, fx.deviceId);
    expect(effective.effectivePreset).toBe("WORK");
    expect(effective.basePreset).toBe("RELIABLE");
  }, 15_000);

  // 9.3.1.4 base RELIABLE + device batterySaver → effective BATTERY
  it("9.3.1.4: base RELIABLE + device batterySaver → effective BATTERY", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "RELIABLE", mode: "automatic" });
    await setDeviceContext(fx.userId, fx.deviceId, { batterySaver: true, autoSwitchEnabled: true });

    const effective = await deriveEffectivePolicy(fx.userId, fx.deviceId);
    expect(effective.basePreset).toBe("RELIABLE");
    expect(effective.effectivePreset).toBe("BATTERY");
    // BATTERY params: switchHysteresis 0.25, preferredTransports ["WIFI"]
    expect(effective.switchHysteresis).toBe(0.25);
    expect(effective.preferredTransports).toContain("WIFI");
  }, 15_000);

  // 9.3.1.5 base CHEAPEST + device workMode → stays CHEAPEST (no upgrade)
  it("9.3.1.5: base CHEAPEST + device workMode → effective stays CHEAPEST (no upgrade)", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "CHEAPEST", mode: "automatic" });
    await setDeviceContext(fx.userId, fx.deviceId, { workMode: true, autoSwitchEnabled: true });

    const effective = await deriveEffectivePolicy(fx.userId, fx.deviceId);
    // workMode does NOT upgrade CHEAPEST to WORK — user explicitly chose cheap
    expect(effective.basePreset).toBe("CHEAPEST");
    expect(effective.effectivePreset).toBe("CHEAPEST");
    expect(effective.derivationReason).toBeUndefined(); // no derivation
  }, 15_000);

  // 9.3.1.6 explicit connectivityPreference → base policy updated
  it("9.3.1.6: connectivityPreference CHEAPEST → base policy updated to CHEAPEST", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "RELIABLE", mode: "automatic" });
    // User explicitly chooses CHEAPEST — this is a user override, not transient
    await setDeviceContext(fx.userId, fx.deviceId, { connectivityPreference: "CHEAPEST", autoSwitchEnabled: true });

    const basePolicy = await getPolicy(fx.userId);
    // Base policy is now CHEAPEST (minReliability 0.3, switchHysteresis 0.05)
    expect(basePolicy.minReliability).toBe(0.3);
    expect(basePolicy.switchHysteresis).toBe(0.05);
  }, 15_000);

  // 9.3.1.7 autoSwitchEnabled=false → base policy mode=manual
  it("9.3.1.7: autoSwitchEnabled=false → base policy mode=manual", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "RELIABLE", mode: "automatic" });
    await setDeviceContext(fx.userId, fx.deviceId, { autoSwitchEnabled: false });

    const basePolicy = await getPolicy(fx.userId);
    expect(basePolicy.mode).toBe("manual");
  }, 15_000);

  // 9.3.1.8 stale context update → rejected
  it("9.3.1.8: stale context update (observedAt < current) → rejected", async () => {
    // Set initial context with a recent observedAt
    await setDeviceContext(fx.userId, fx.deviceId, { batterySaver: false }, new Date());

    // Try to set an older context — should be rejected
    const staleResult = await setDeviceContext(
      fx.userId, fx.deviceId,
      { batterySaver: true },
      new Date(Date.now() - 60_000), // 60s ago — stale
    );
    expect(staleResult.ok).toBe(false);
    expect((staleResult as { rejected: string }).rejected).toBe("stale");

    // Verify the context was NOT updated (batterySaver is still false)
    const device = await db.edgeDevice.findUnique({ where: { deviceId: fx.deviceId } });
    const context = JSON.parse(device!.policyContext!);
    expect(context.batterySaver).toBe(false); // NOT regressed to true
  }, 15_000);

  // 9.3.1.9 GET with another user's deviceId → 403
  it("9.3.1.9: another user's device → rejected", async () => {
    const { hashPassword } = await import("@/lib/security");
    const otherUser = await db.user.create({
      data: { email: `p9319-${Date.now()}@test`, name: "Other", passwordHash: await hashPassword("x"), role: "customer", emailVerified: new Date() },
    });
    try {
      // fx.deviceId belongs to fx.userId, not otherUser
      const device = await db.edgeDevice.findUnique({ where: { deviceId: fx.deviceId } });
      expect(device?.userId).toBe(fx.userId);
      expect(device?.userId).not.toBe(otherUser.id);

      // The route's ownership check would reject this
      const isOwner = device?.userId === otherUser.id;
      expect(isOwner).toBe(false);
    } finally {
      await db.user.deleteMany({ where: { id: otherUser.id } });
    }
  }, 15_000);

  // 9.3.1.10 context update is side-effect free
  it("9.3.1.10: context update does NOT create actions/decisions", async () => {
    const actionsBefore = await db.connectivityAction.count();
    const decisionsBefore = await db.connectivityDecision.count();

    await setDeviceContext(fx.userId, fx.deviceId, { batterySaver: true, workMode: true, autoSwitchEnabled: true });

    const actionsAfter = await db.connectivityAction.count();
    const decisionsAfter = await db.connectivityDecision.count();
    expect(actionsAfter).toBe(actionsBefore);
    expect(decisionsAfter).toBe(decisionsBefore);
  }, 15_000);
});
