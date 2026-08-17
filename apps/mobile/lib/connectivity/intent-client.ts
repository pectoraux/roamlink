/**
 * Phase 9.5 (R3) — Mobile Intent Client
 *
 * The edge intent layer. Creates, updates, cancels, and reads intents.
 * Uses the offline outbox for durable delivery.
 *
 * The mobile is an intent CLIENT, not a decision client:
 *   YES: create intent, update intent, view intent state, retry delivery
 *   NO:  decide provider, rank resources, activate connectivity, override policy
 */

import { api, getSession } from "../api";
import { getDeviceId } from "./device-context";
import {
  enqueueIntentOperation,
  loadPendingIntentOperations,
  acknowledgeIntentOperation,
  failIntentOperation,
  type CreateIntentPayload,
  type IntentOutboxEntry,
} from "./intent-outbox";
import type { EdgePolicyContext } from "@roamlink/shared";

// ---------------------------------------------------------------------------
// Create an intent (offline-safe via outbox)
// ---------------------------------------------------------------------------

export async function createIntent(input: CreateIntentPayload): Promise<string> {
  const deviceId = await getDeviceId();
  const idempotencyKey = `intent-create-${deviceId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  return enqueueIntentOperation({
    type: "CREATE",
    payload: { ...input, deviceId },
    idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Supersede an intent (offline-safe via outbox)
// ---------------------------------------------------------------------------

export async function supersedeIntent(
  intentId: string,
  expectedVersion: number,
  input: CreateIntentPayload,
): Promise<string> {
  const deviceId = await getDeviceId();
  const idempotencyKey = `intent-supersede-${intentId}-${expectedVersion}-${Date.now().toString(36)}`;

  return enqueueIntentOperation({
    type: "SUPERSEDE",
    intentId,
    expectedVersion,
    payload: { ...input, deviceId },
    idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Cancel an intent (offline-safe via outbox)
// ---------------------------------------------------------------------------

export async function cancelIntent(
  intentId: string,
  expectedVersion: number,
): Promise<string> {
  const idempotencyKey = `intent-cancel-${intentId}-${expectedVersion}-${Date.now().toString(36)}`;

  return enqueueIntentOperation({
    type: "CANCEL",
    intentId,
    expectedVersion,
    idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Get the current active intent from the server (read-only)
// ---------------------------------------------------------------------------

export async function getCurrentIntent(): Promise<{
  intentId: string;
  version: number;
  status: string;
  rawText?: string;
  mode?: string;
  priority?: string;
} | null> {
  const token = await getSession();
  if (!token) return null;

  try {
    const response = await fetch(
      `${process.env.EXPO_PUBLIC_API_URL || "https://roamlink-chi.vercel.app"}/api/v1/connectivity/intents`,
      { headers: { Cookie: `esim_session=${token}` } },
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.intent) return null;

    return {
      intentId: data.intent.intentId,
      version: data.intent.version,
      status: data.intent.status,
      rawText: data.intent.payload?.rawText,
      mode: data.intent.payload?.mode,
      priority: data.intent.payload?.priority,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flush the intent outbox (sync pending operations to the server)
// ---------------------------------------------------------------------------

export async function flushIntentOutbox(): Promise<{ synced: number; failed: number }> {
  const token = await getSession();
  if (!token) return { synced: 0, failed: 0 };

  const pending = await loadPendingIntentOperations();
  if (pending.length === 0) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;

  for (const entry of pending) {
    try {
      const result = await syncOneOperation(token, entry);
      if (result) {
        await acknowledgeIntentOperation(entry.id, result.intentId, result.version);
        synced++;
      } else {
        await failIntentOperation(entry.id);
        failed++;
      }
    } catch {
      await failIntentOperation(entry.id);
      failed++;
    }
  }

  return { synced, failed };
}

async function syncOneOperation(
  token: string,
  entry: IntentOutboxEntry,
): Promise<{ intentId: string; version: number } | null> {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL || "https://roamlink-chi.vercel.app";

  switch (entry.operation.type) {
    case "CREATE": {
      const res = await fetch(`${baseUrl}/api/v1/connectivity/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `esim_session=${token}` },
        body: JSON.stringify({ ...entry.operation.payload, idempotencyKey: entry.operation.idempotencyKey }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return { intentId: data.intentId, version: data.version };
    }
    case "SUPERSEDE": {
      const res = await fetch(`${baseUrl}/api/v1/connectivity/intents/${entry.operation.intentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `esim_session=${token}` },
        body: JSON.stringify({
          action: "supersede",
          expectedVersion: entry.operation.expectedVersion,
          idempotencyKey: entry.operation.idempotencyKey,
          ...entry.operation.payload,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return { intentId: data.intentId, version: data.version };
    }
    case "CANCEL": {
      const res = await fetch(`${baseUrl}/api/v1/connectivity/intents/${entry.operation.intentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `esim_session=${token}` },
        body: JSON.stringify({
          action: "cancel",
          expectedVersion: entry.operation.expectedVersion,
          idempotencyKey: entry.operation.idempotencyKey,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return { intentId: entry.operation.intentId, version: data.version };
    }
  }
  return null;
}
