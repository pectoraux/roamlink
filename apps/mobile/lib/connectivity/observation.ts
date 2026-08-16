/**
 * Phase 9.1 — Observation
 *
 * Builds EdgeObservation events from device context + connectivity state.
 * The observation is the immutable telemetry unit — the device reports WHAT
 * IT SEES, never what the system should DO.
 */

import type { EdgeObservation } from "@roamlink/shared";
import { getDeviceContext, getDeviceId, getSequence } from "./device-context";
import { getCurrentConnectivity } from "./connectivity-state";

export type RecordObservationInput = {
  sessionId?: string;
  resourceId?: string;
};

/**
 * Record a single connectivity observation. Generates a stable observationId,
 * assigns a monotonic sequence, captures device context + connectivity state.
 *
 * The observation is returned (not yet persisted — the outbox handles that).
 */
export async function recordObservation(input: RecordObservationInput = {}): Promise<EdgeObservation> {
  const [deviceId, sequence, device, connectivity] = await Promise.all([
    getDeviceId(),
    getSequence(),
    getDeviceContext(),
    getCurrentConnectivity(),
  ]);

  const observation: EdgeObservation = {
    observationId: `obs-${deviceId}-${sequence}-${Date.now().toString(36)}`,
    deviceId,
    sessionId: input.sessionId,
    resourceId: input.resourceId,
    observedAt: new Date().toISOString(),
    sequence,
    source: "DEVICE",
    connectivity,
    device,
  };

  return observation;
}
