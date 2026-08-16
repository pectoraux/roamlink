/**
 * Phase 9.1.1 — Observation
 *
 * Builds EdgeObservation events from device context + connectivity state.
 * The observation is the immutable telemetry unit — the device reports WHAT
 * IT SEES, never what the system should DO.
 *
 * Phase 9.1.1: sequence allocation + outbox write are now ATOMIC (via
 * allocateSequenceAndEnqueue). This prevents the race where two concurrent
 * observations read the same sequence number.
 */

import type { EdgeObservation } from "@roamlink/shared";
import { getDeviceContext, getDeviceId } from "./device-context";
import { getCurrentConnectivity } from "./connectivity-state";
import { allocateSequenceAndEnqueue } from "./outbox";

export type RecordObservationInput = {
  sessionId?: string;
  resourceId?: string;
};

/**
 * Record a single connectivity observation. Atomically allocates a sequence
 * number AND enqueues the observation to the outbox under one mutex, so
 * concurrent observations get unique sequences and aren't lost.
 *
 * Returns the persisted observation.
 */
export async function recordObservation(input: RecordObservationInput = {}): Promise<EdgeObservation> {
  const [deviceId, device, connectivity] = await Promise.all([
    getDeviceId(),
    getDeviceContext(),
    getCurrentConnectivity(),
  ]);

  // Atomically allocate sequence + enqueue. The buildObservation callback
  // receives the allocated sequence and constructs the full observation.
  const obs = await allocateSequenceAndEnqueue(deviceId, (sequence) => ({
    observationId: `obs-${deviceId}-${sequence}-${Date.now().toString(36)}`,
    deviceId,
    sessionId: input.sessionId,
    resourceId: input.resourceId,
    observedAt: new Date().toISOString(),
    sequence,
    source: "DEVICE",
    connectivity,
    device,
  }));

  return obs;
}
