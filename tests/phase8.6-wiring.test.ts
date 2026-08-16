/**
 * Phase 8.6 — Continuous Connectivity Observation (static wiring)
 *
 * These tests verify the structure and wiring of the Phase 8.6 observation
 * layer, consistent with the existing Phase 8 static-inspection pattern.
 * The DB-backed runtime proof lives in phase8.6-observation-loop.test.ts.
 *
 * Tests:
 *   8.6.1:  MeasurementSource enum (ADAPTER|DEVICE|PROBE|PROVIDER|DERIVED)
 *   8.6.2:  Freshness model (FRESH|STALE|EXPIRED|UNKNOWN) + thresholds
 *   8.6.3:  ingestMeasurement validates source provenance (rejects unknown)
 *   8.6.4:  deriveResourceHealth persists ResourceHealth (M-of-N degraded)
 *   8.6.5:  Re-evaluation event types + triggerReevaluation + isReevaluationNecessary
 *   8.6.6:  probeAndIngest uses adapter.getUsage + source=ADAPTER
 *   8.6.7:  decision engine consults persisted ResourceHealth + freshness gate
 *   8.6.8:  Schema: ResourceHealth + ReevaluationEvent + entitlement.userId + source
 *   8.6.9:  API: measurements route → ingestMeasurement; observe-connectivity cron
 *   8.6.10: Action executor runtime fix: PLANNED → DISCOVERING → ACTIVE
 *   KERNEL: entitlement.ts / ranking-engine / ledger unchanged
 */

import { describe, expect, it } from "bun:test";

describe("Phase 8.6 — Continuous Connectivity Observation (wiring)", () => {
  // -------------------------------------------------------------------------
  // 1. Measurement source provenance
  // -------------------------------------------------------------------------
  it("8.6.1: MeasurementSource enum (ADAPTER|DEVICE|PROBE|PROVIDER|DERIVED)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(source).toContain("MeasurementSourceSchema");
    expect(source).toContain('"ADAPTER"');
    expect(source).toContain('"DEVICE"');
    expect(source).toContain('"PROBE"');
    expect(source).toContain('"PROVIDER"');
    expect(source).toContain('"DERIVED"');
  });

  it("8.6.1b: measurement-store validates source + rejects unknown", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/measurement-store.ts", "utf-8");
    expect(source).toContain("VALID_SOURCES");
    expect(source).toContain("isValidSource");
    expect(source).toContain("Invalid measurement source");
    expect(source).toContain("must preserve provenance");
  });

  // -------------------------------------------------------------------------
  // 2. Freshness model
  // -------------------------------------------------------------------------
  it("8.6.2: freshness FRESH|STALE|EXPIRED|UNKNOWN + thresholds + gating", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/freshness.ts", "utf-8");
    expect(source).toContain("classifyFreshness");
    expect(source).toContain("DEFAULT_FRESH_MS");
    expect(source).toContain("DEFAULT_STALE_MS");
    expect(source).toContain("mayTriggerAutomaticSwitch");
    expect(source).toContain("contributesToHealth");
    // Freshness gating: only FRESH may trigger automatic switch
    expect(source).toContain('freshness === "FRESH"');
  });

  // -------------------------------------------------------------------------
  // 3. Health derivation (persisted, M-of-N)
  // -------------------------------------------------------------------------
  it("8.6.4: deriveResourceHealth persists ResourceHealth (M-of-N degraded)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/health-derivation.ts", "utf-8");
    expect(source).toContain("export async function deriveResourceHealth");
    expect(source).toContain("deriveSampleQuality");
    expect(source).toContain("degradedThreshold");
    expect(source).toContain("minDegradedCount");
    expect(source).toContain("M-of-N");
    // Persists via upsert
    expect(source).toContain("db.resourceHealth.upsert");
    // Excludes EXPIRED
    expect(source).toContain("contributesToHealth");
    // Returns the snapshot
    expect(source).toContain("getResourceHealth");
  });

  // -------------------------------------------------------------------------
  // 4. Re-evaluation events
  // -------------------------------------------------------------------------
  it("8.6.5: re-evaluation event types + triggerReevaluation + isReevaluationNecessary", async () => {
    const fs = await import("fs");
    const proto = fs.readFileSync("src/lib/protocol/index.ts", "utf-8");
    expect(proto).toContain("ReevaluationEventTypeSchema");
    for (const t of [
      "MEASUREMENT_RECEIVED",
      "RESOURCE_DEGRADED",
      "RESOURCE_RECOVERED",
      "QUOTA_THRESHOLD_REACHED",
      "PROVIDER_UNAVAILABLE",
      "LOCATION_CHANGED",
      "POLICY_CHANGED",
    ]) {
      expect(proto).toContain(`"${t}"`);
    }

    const source = fs.readFileSync("src/lib/control-plane/reevaluation.ts", "utf-8");
    expect(source).toContain("export async function isReevaluationNecessary");
    expect(source).toContain("export async function triggerReevaluation");
    expect(source).toContain("export async function processPendingEvents");
    expect(source).toContain("makeDecision");
    expect(source).toContain("createAction");
    expect(source).toContain("executeAction");
    // Persists events
    expect(source).toContain("db.reevaluationEvent");
  });

  it("8.6.5b: measurement-store emits MEASUREMENT_RECEIVED + transition events", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/measurement-store.ts", "utf-8");
    expect(source).toContain("MEASUREMENT_RECEIVED");
    expect(source).toContain("RESOURCE_DEGRADED");
    expect(source).toContain("RESOURCE_RECOVERED");
    expect(source).toContain("emitEvent");
  });

  // -------------------------------------------------------------------------
  // 5. Observation probe
  // -------------------------------------------------------------------------
  it("8.6.6: probeAndIngest uses adapter.getUsage + source=ADAPTER", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/observation.ts", "utf-8");
    expect(source).toContain("export async function probeAndIngest");
    expect(source).toContain("adapter.getUsage");
    expect(source).toContain('source: "ADAPTER"');
    expect(source).toContain("ingestMeasurement");
    expect(source).toContain("resolveBindingAdapter");
  });

  // -------------------------------------------------------------------------
  // 6. Decision engine consults persisted health + freshness gate
  // -------------------------------------------------------------------------
  it("8.6.7: decision engine consults persisted ResourceHealth + freshness gate", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/decision-engine.ts", "utf-8");
    expect(source).toContain("getResourceHealth");
    expect(source).toContain("mayTriggerAutomaticSwitch");
    expect(source).toContain("FRESHNESS_GATE_ENFORCED");
    expect(source).toContain("STALE_HEALTH");
    expect(source).toContain("HEALTH_FRESH");
    expect(source).toContain("health.status");
    expect(source).toContain("health.quality");
    // No longer fetches raw measurements inline for hysteresis
    expect(source).not.toContain("DEGRADATION_THRESHOLD");
    expect(source).not.toContain("MIN_DEGRADED_COUNT");
  });

  // -------------------------------------------------------------------------
  // 7. Schema
  // -------------------------------------------------------------------------
  it("8.6.8: schema has ResourceHealth + ReevaluationEvent + entitlement.userId + source", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(source).toContain("model ResourceHealth");
    expect(source).toContain("model ReevaluationEvent");
    // ResourceHealth: persisted snapshot
    const healthModel = source.substring(source.indexOf("model ResourceHealth"), source.indexOf("model ReevaluationEvent"));
    expect(healthModel).toContain("resourceId      String   @unique");
    expect(healthModel).toContain("status");
    expect(healthModel).toContain("quality");
    expect(healthModel).toContain("sampleCount");
    expect(healthModel).toContain("degradedCount");
    expect(healthModel).toContain("freshness");
    expect(healthModel).toContain("derivedFromSources");
    // ReevaluationEvent
    const eventModel = source.substring(source.indexOf("model ReevaluationEvent"));
    expect(eventModel).toContain("processedAt");
    expect(eventModel).toContain("payload");
    // Entitlement userId (schema drift fix)
    const entModel = source.substring(source.indexOf("model ConnectivityEntitlement"), source.indexOf("model ProviderResourceBinding"));
    expect(entModel).toContain("userId          String?");
    // Measurement source non-null + index
    const measModel = source.substring(source.indexOf("model ConnectivityMeasurement"), source.indexOf("model ConnectivityPolicy"));
    expect(measModel).toContain('source          String   @default("PROVIDER")');
    expect(measModel).toContain("@@index([source])");
  });

  // -------------------------------------------------------------------------
  // 8. API wiring
  // -------------------------------------------------------------------------
  it("8.6.9: measurements route → ingestMeasurement; observe-connectivity cron exists", async () => {
    const fs = await import("fs");
    const route = fs.readFileSync("src/app/api/v1/connectivity/measurements/route.ts", "utf-8");
    expect(route).toContain("ingestMeasurement");
    expect(route).toContain("isValidSource");

    const cron = fs.readFileSync("src/app/api/internal/observe-connectivity/route.ts", "utf-8");
    expect(cron).toContain("probeAllActiveSessions");
    expect(cron).toContain("processPendingEvents");
    expect(cron).toContain("CRON_SECRET");
  });

  // -------------------------------------------------------------------------
  // 9. Action executor runtime fix
  // -------------------------------------------------------------------------
  it("8.6.10: action executor transitions PLANNED → DISCOVERING → ACTIVE", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/control-plane/action-executor.ts", "utf-8");
    const activateCase = source.substring(source.indexOf('case "ACTIVATE"'), source.indexOf('case "SWITCH"'));
    expect(activateCase).toContain('transitionSessionState(session.id, "DISCOVERING")');
    expect(activateCase).toContain('transitionSessionState(session.id, "ACTIVE")');
    expect(activateCase).toContain("PLANNED → DISCOVERING → ACTIVE");
  });

  // -------------------------------------------------------------------------
  // Kernel preservation
  // -------------------------------------------------------------------------
  it("KERNEL: entitlement.ts has no Phase 8.6 code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/entitlement.ts", "utf-8");
    expect(source).not.toContain("ingestMeasurement");
    expect(source).not.toContain("deriveResourceHealth");
    expect(source).not.toContain("ResourceHealth");
    expect(source).not.toContain("ReevaluationEvent");
    expect(source).not.toContain("probeAndIngest");
    expect(source).toContain("export async function provisionBinding");
  });

  it("KERNEL: adapter contract unchanged (still exports getUsage + reconcile)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/connectivity/adapter.ts", "utf-8");
    expect(source).toContain("getUsage(input:");
    expect(source).toContain("reconcile(input:");
    expect(source).toContain("ConnectivityProviderAdapter");
  });

  it("KERNEL: ranking engine has no observation code", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/lib/commerce/ranking-engine.ts", "utf-8");
    expect(source).not.toContain("ResourceHealth");
    expect(source).not.toContain("ingestMeasurement");
    expect(source).toContain("export async function rankOffers");
  });
});
