/**
 * Phase 9.3.2 — Policy Provenance & Authority Closure (DB-backed runtime)
 *
 * Proves the four hard invariants:
 *
 *   9.3.2.1  Effective policy cannot be bypassed (no policy? escape hatch)
 *   9.3.2.2  Policy identity is first-class (stored preset, not reverse-engineered)
 *   9.3.2.3  Decision provenance is durable (basePolicyId, contextVersion, etc.)
 *   9.3.2.4  batterySaver is a server-defined rule, not a hard-coded physical law
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { config } from "dotenv";
config({ override: true });

import { registerEdgeDevice } from "@/lib/control-plane/edge-ingestion";
import { createOrUpdatePolicy, getPolicy } from "@/lib/control-plane/policy-engine";
import { deriveEffectivePolicy, BATTERY_SAVER_RULE } from "@/lib/control-plane/effective-policy";
import type { EdgePolicyContext } from "@roamlink/shared";

type Fixture = {
  userId: string;
  deviceId: string;
  cleanup: () => Promise<void>;
};

async function setupFixture(): Promise<Fixture> {
  const { hashPassword } = await import("@/lib/security");
  const email = `phase932-${Date.now()}@test.roamlink`;
  const user = await db.user.create({
    data: { email, name: "P932 User", passwordHash: await hashPassword("test12345"), role: "customer", emailVerified: new Date() },
  });
  const deviceId = `p932-dev-${Date.now().toString(36)}`;
  await registerEdgeDevice({ userId: user.id, deviceId, platform: "android", appVersion: "0.1.0" });

  const cleanup = async () => {
    await db.edgeObservationRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.edgeDevice.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.connectivityPolicy.deleteMany({ where: { subjectId: user.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  };

  return { userId: user.id, deviceId, cleanup };
}

async function setDeviceContext(userId: string, deviceId: string, context: EdgePolicyContext) {
  await db.edgeDevice.update({
    where: { deviceId },
    data: {
      policyContext: JSON.stringify(context),
      policyContextUpdatedAt: new Date(),
      policyContextObservedAt: new Date(),
      policyContextVersion: { increment: 1 },
    },
  });
}

describe("Phase 9.3.2 — Policy Provenance & Authority Closure (DB-backed)", () => {
  let fx: Fixture;

  beforeAll(async () => { fx = await setupFixture(); }, 30_000);
  afterAll(async () => { if (fx) await fx.cleanup(); }, 30_000);

  // 9.3.2.1 Effective policy cannot be bypassed
  it("9.3.2.1: DecisionInput has no policy escape hatch in the type definition", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    // Extract just the DecisionInput type definition (not comments)
    const typeMatch = source.match(/export type DecisionInput = \{[^}]+\}/);
    expect(typeMatch).not.toBeNull();
    const typeDef = typeMatch![0];
    // The type definition must NOT have a policy field
    expect(typeDef).not.toMatch(/policy\?\s*:/);
    // Policy resolution is internal
    expect(source).toContain("deriveEffectivePolicy");
  }, 10_000);

  // 9.3.2.2 Policy identity is first-class (stored preset)
  it("9.3.2.2: policy preset stored explicitly (not reverse-engineered)", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "RELIABLE", mode: "automatic" });
    const policy = await getPolicy(fx.userId);
    expect(policy.preset).toBe("RELIABLE");
    expect(policy.version).toBeGreaterThan(0);

    // Even after a mode-only update, preset is preserved
    await createOrUpdatePolicy({ subjectId: fx.userId, mode: "manual" });
    const updated = await getPolicy(fx.userId);
    expect(updated.preset).toBe("RELIABLE"); // preset preserved
    expect(updated.mode).toBe("manual");
    expect(updated.version).toBeGreaterThan(policy.version); // version incremented
  }, 15_000);

  // 9.3.2.3 Decision provenance is durable
  it("9.3.2.3: effective policy returns provenance fields", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "RELIABLE", mode: "automatic" });
    await setDeviceContext(fx.userId, fx.deviceId, { batterySaver: true, autoSwitchEnabled: true });

    const effective = await deriveEffectivePolicy(fx.userId, fx.deviceId);
    expect(effective.basePolicyId).not.toBeNull();
    expect(effective.basePolicyVersion).toBeGreaterThan(0);
    expect(effective.basePreset).toBe("RELIABLE");
    expect(effective.effectivePreset).toBe("BATTERY");
    expect(effective.contextDeviceId).toBe(fx.deviceId);
    expect(effective.contextVersion).not.toBeNull();
    expect(effective.contextObservedAt).not.toBeNull();
    expect(effective.derivationReason).toContain("batterySaver");
  }, 15_000);

  // 9.3.2.4 batterySaver is a server-defined rule (not a physical law)
  it("9.3.2.4: batterySaver rule is configurable (can be disabled)", async () => {
    await createOrUpdatePolicy({ subjectId: fx.userId, preset: "RELIABLE", mode: "automatic" });
    await setDeviceContext(fx.userId, fx.deviceId, { batterySaver: true, autoSwitchEnabled: true });

    // Default: batterySaver overrides base
    const defaultEffective = await deriveEffectivePolicy(fx.userId, fx.deviceId);
    expect(defaultEffective.effectivePreset).toBe("BATTERY");

    // Save the original rule value
    const originalOverride = BATTERY_SAVER_RULE.overridesBase;

    // Disable the rule — batterySaver no longer overrides
    BATTERY_SAVER_RULE.overridesBase = false;
    const disabledEffective = await deriveEffectivePolicy(fx.userId, fx.deviceId);
    expect(disabledEffective.effectivePreset).toBe("RELIABLE"); // base preserved

    // Restore the rule
    BATTERY_SAVER_RULE.overridesBase = originalOverride;
  }, 15_000);

  // 9.3.2.5 detectBasePreset is removed (no reverse-engineering)
  it("9.3.2.5: effective-policy.ts uses stored preset, not detectBasePreset function", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/effective-policy.ts", "utf-8");
    // The function definition must not exist
    expect(source).not.toMatch(/function detectBasePreset/);
    // Uses the stored preset field
    expect(source).toContain("basePolicy.preset");
  }, 10_000);

  // 9.3.2.6 custom policy (preset=null) is handled correctly
  it("9.3.2.6: custom policy (no preset) → effectivePreset = MANUAL", async () => {
    // Create a custom policy by setting individual params without a preset
    await db.connectivityPolicy.deleteMany({ where: { subjectId: fx.userId } });
    await db.connectivityPolicy.create({
      data: {
        subjectId: fx.userId,
        mode: "automatic",
        maxAutoSpendMinor: 5000,
        minReliability: 0.8,
        switchHysteresis: 0.12,
        requireUserApprovalForPurchase: false,
        neverInterruptActiveCall: true,
        preset: null, // custom — no preset identity
        version: 1,
      },
    });

    const effective = await deriveEffectivePolicy(fx.userId);
    expect(effective.basePreset).toBeNull();
    expect(effective.effectivePreset).toBe("MANUAL");
    expect(effective.basePolicyVersion).toBe(1);
  }, 15_000);
});
