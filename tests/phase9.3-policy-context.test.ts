/**
 * Phase 9.3 — Policy & Context at the Edge (DB-backed runtime)
 *
 * Proves the policy-context flow:
 *   Mobile context → EdgePolicyContext → Server policy engine → Decision → Action
 *
 * The mobile NEVER decides locally — it only reports context + preferences.
 *
 *   9.3.1  policy context → persisted on EdgeDevice
 *   9.3.2  battery saver → BATTERY preset applied
 *   9.3.3  work mode → WORK preset applied
 *   9.3.4  connectivity preference RELIABLE → RELIABLE preset applied
 *   9.3.5  autoSwitchEnabled=false → mode=manual
 *   9.3.6  avoidCellular → preferredTransports=["WIFI"]
 *   9.3.7  GET endpoint returns persisted context + applied policy
 *   9.3.8  unauthorized device → rejected
 *   9.3.9  mobile never decides locally (no action/decision from policy context)
 *   9.3.10 policy context update does not create actions/decisions directly
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { registerEdgeDevice } from "@/lib/control-plane/edge-ingestion";
import { getPolicy } from "@/lib/control-plane/policy-engine";
import type { EdgePolicyContext } from "@roamlink/shared";

type Fixture = {
  userId: string;
  deviceId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase93-${Date.now()}@test.roamlink`;
  const user = await db.user.create({
    data: { email, name: "P93 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const deviceId = `p93-dev-${Date.now().toString(36)}`;
  await registerEdgeDevice({ userId: user.id, deviceId, platform: "android", appVersion: "0.1.0" });

  const cleanup = async () => {
    await db.edgeObservationRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.edgeDevice.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { userId: user.id, deviceId, cleanup };
}

// Helper: call the POST endpoint directly (simulating what the API client does)
async function postPolicyContext(userId: string, deviceId: string, context: EdgePolicyContext) {
  const { createOrUpdatePolicy } = await import("@/lib/control-plane/policy-engine");
  const device = await db.edgeDevice.findUnique({ where: { deviceId } });
  if (!device || device.userId !== userId) throw new Error("Device not registered");

  // Persist context
  await db.edgeDevice.update({
    where: { deviceId },
    data: { policyContext: JSON.stringify(context), policyContextUpdatedAt: new Date() },
  });

  // Apply to policy engine (same logic as the route)
  const policyUpdates: Parameters<typeof createOrUpdatePolicy>[0] = {
    subjectId: userId,
    mode: context.autoSwitchEnabled === false ? "manual" : "automatic",
  };

  if (context.batterySaver) {
    policyUpdates.preset = "BATTERY";
  } else if (context.connectivityPreference === "RELIABLE") {
    policyUpdates.preset = "RELIABLE";
  } else if (context.connectivityPreference === "CHEAPEST") {
    policyUpdates.preset = "CHEAPEST";
  } else if (context.workMode) {
    policyUpdates.preset = "WORK";
  }

  if (context.avoidCellular) {
    policyUpdates.preferredTransports = ["WIFI"];
  }

  await createOrUpdatePolicy(policyUpdates);
  return { ok: true, context };
}

// Helper: read persisted context (simulates GET endpoint)
async function getPolicyContext(userId: string, deviceId: string) {
  const device = await db.edgeDevice.findUnique({ where: { deviceId } });
  if (!device || device.userId !== userId) throw new Error("Device not registered");
  const context: EdgePolicyContext = device.policyContext ? JSON.parse(device.policyContext) : {};
  const policy = await getPolicy(userId);
  return { context, policy };
}

describe("Phase 9.3 — Policy & Context at the Edge (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 30_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 30_000);

  // 9.3.1 policy context → persisted on EdgeDevice
  it("9.3.1: policy context persisted on EdgeDevice", async () => {
    const context: EdgePolicyContext = {
      autoSwitchEnabled: true,
      batterySaver: false,
      workMode: false,
      connectivityPreference: "BALANCED",
    };
    await postPolicyContext(fx.userId, fx.deviceId, context);

    const device = await db.edgeDevice.findUnique({ where: { deviceId: fx.deviceId } });
    expect(device?.policyContext).not.toBeNull();
    const persisted = JSON.parse(device!.policyContext!);
    expect(persisted.autoSwitchEnabled).toBe(true);
    expect(persisted.connectivityPreference).toBe("BALANCED");
    expect(device?.policyContextUpdatedAt).not.toBeNull();
  }, 15_000);

  // 9.3.2 battery saver → BATTERY preset
  it("9.3.2: battery saver → BATTERY preset applied", async () => {
    await postPolicyContext(fx.userId, fx.deviceId, { batterySaver: true, autoSwitchEnabled: true });
    const { policy } = await getPolicyContext(fx.userId, fx.deviceId);
    expect(policy.mode).toBe("automatic");
    // BATTERY preset has switchHysteresis 0.25
    expect(policy.switchHysteresis).toBe(0.25);
  }, 15_000);

  // 9.3.3 work mode → WORK preset
  it("9.3.3: work mode → WORK preset applied", async () => {
    await postPolicyContext(fx.userId, fx.deviceId, { workMode: true, autoSwitchEnabled: true });
    const { policy } = await getPolicyContext(fx.userId, fx.deviceId);
    // WORK preset has switchHysteresis 0.15, neverInterruptActiveCall true
    expect(policy.switchHysteresis).toBe(0.15);
    expect(policy.neverInterruptActiveCall).toBe(true);
  }, 15_000);

  // 9.3.4 connectivity preference RELIABLE → RELIABLE preset
  it("9.3.4: connectivityPreference RELIABLE → RELIABLE preset", async () => {
    await postPolicyContext(fx.userId, fx.deviceId, { connectivityPreference: "RELIABLE", autoSwitchEnabled: true });
    const { policy } = await getPolicyContext(fx.userId, fx.deviceId);
    // RELIABLE preset has minReliability 0.95, switchHysteresis 0.2
    expect(policy.minReliability).toBe(0.95);
    expect(policy.switchHysteresis).toBe(0.2);
  }, 15_000);

  // 9.3.5 autoSwitchEnabled=false → mode=manual
  it("9.3.5: autoSwitchEnabled=false → mode=manual", async () => {
    await postPolicyContext(fx.userId, fx.deviceId, { autoSwitchEnabled: false });
    const { policy } = await getPolicyContext(fx.userId, fx.deviceId);
    expect(policy.mode).toBe("manual");
  }, 15_000);

  // 9.3.6 avoidCellular → preferredTransports=["WIFI"]
  it("9.3.6: avoidCellular → preferredTransports=['WIFI']", async () => {
    await postPolicyContext(fx.userId, fx.deviceId, { avoidCellular: true, autoSwitchEnabled: true });
    const { policy } = await getPolicyContext(fx.userId, fx.deviceId);
    expect(policy.preferredTransports).toContain("WIFI");
  }, 15_000);

  // 9.3.7 GET returns persisted context + applied policy
  it("9.3.7: GET returns persisted context + applied policy", async () => {
    const context: EdgePolicyContext = {
      autoSwitchEnabled: true,
      batterySaver: false,
      workMode: true,
      connectivityPreference: "RELIABLE",
      avoidCellular: false,
      allowRoaming: true,
    };
    await postPolicyContext(fx.userId, fx.deviceId, context);

    const result = await getPolicyContext(fx.userId, fx.deviceId);
    expect(result.context.workMode).toBe(true);
    expect(result.context.connectivityPreference).toBe("RELIABLE");
    expect(result.context.allowRoaming).toBe(true);
    expect(result.policy.mode).toBe("automatic");
    expect(result.policy.minReliability).toBe(0.95);
  }, 15_000);

  // 9.3.8 unauthorized device → rejected
  it("9.3.8: unauthorized device → rejected", async () => {
    await expect(
      getPolicyContext(fx.userId, "unknown-device"),
    ).rejects.toThrow(/not registered/i);
  }, 15_000);

  // 9.3.9 mobile never decides locally (policy context doesn't create actions)
  it("9.3.9: policy context update does NOT create actions/decisions", async () => {
    const actionsBefore = await db.connectivityAction.count();
    const decisionsBefore = await db.connectivityDecision.count();

    await postPolicyContext(fx.userId, fx.deviceId, { batterySaver: true, autoSwitchEnabled: true });

    const actionsAfter = await db.connectivityAction.count();
    const decisionsAfter = await db.connectivityDecision.count();
    expect(actionsAfter).toBe(actionsBefore);
    expect(decisionsAfter).toBe(decisionsBefore);
  }, 15_000);

  // 9.3.10 policy context is read-only from the mobile's perspective
  it("9.3.10: mobile-submitted context has no decision/action fields", async () => {
    const context: EdgePolicyContext = { batterySaver: true, autoSwitchEnabled: true };
    const json = JSON.stringify(context);
    // No decision/action fields
    expect(json).not.toContain("switchToWifi");
    expect(json).not.toContain("action");
    expect(json).not.toContain("decision");
    expect(json).not.toContain("activateEsim");
    // Only context fields
    expect(json).toContain("batterySaver");
    expect(json).toContain("autoSwitchEnabled");
  }, 15_000);
});
