# Phase 8.6 — Continuous Connectivity Observation

> **Architectural rule (frozen from this point forward):** the control plane may
> only declare `SUCCEEDED` when provider truth, session state, resource state,
> binding identity, and entitlement identity all converge. The invariant checker
> is the mechanism that enforces this.

Phase 8.5 closed the *structural* control plane: durable actions, kernel bridge,
fail-closed verification, ABA-fenced recovery, and the active-connectivity
invariant. Every one of those tests was **static source inspection** — none of
them ever executed against a database. Phase 8.6 changes that: it builds the
continuous observation loop that feeds the decision engine, and it **proves the
loop against a real PostgreSQL database and the mock provider adapter**.

The transition is:

```
CURRENT (Phase 8.5)
  measurement → test fixture → decision

TARGET (Phase 8.6)
  provider → continuous measurements → persistent observations
          → session health
          → decision trigger
          → kernel bridge → provider adapter → provider truth
          → verification → invariant → session
```

## Architecture

```
Provider Adapter (getUsage / reconcile)
      │
      ▼
Observation (probeAndIngest)
      │
      ▼
Measurement Store (ingestMeasurement)  ── provenance: ADAPTER|DEVICE|PROBE|PROVIDER|DERIVED
      │
      ▼
Health / Quality Derivation (deriveResourceHealth)  ── persisted ResourceHealth
      │
      ▼
Decision Engine (consults persisted health + freshness)
      │
      ▼
Policy
      │
      ▼
Action Executor  ── kernel bridge ── frozen kernel ── adapter ── provider truth
      │
      ▼
Invariant (provider truth + session + resource + binding + entitlement converge)
      │
      ▼
Session (ACTIVE on the verified resource)
```

## 8.6.1 — Measurement ingestion (first-class events with provenance)

Measurements become first-class events. The critical field is **`source`** —
provenance must never be lost. Provider-reported metrics and client-observed
metrics must never be mixed without preserving which is which.

```
source ∈ { ADAPTER, DEVICE, PROBE, PROVIDER, DERIVED }
```

- `ADAPTER`  — the provider adapter reported this (via `getUsage`/`reconcile`).
- `DEVICE`   — the end-user device observed this (client-side telemetry).
- `PROBE`    — an independent probe/synthetic check observed this.
- `PROVIDER` — the supplier's own API reported this (raw, pre-adapter).
- `DERIVED`  — computed from other measurements (aggregates, sma).

**Schema change:** `ConnectivityMeasurement.source` becomes `@default("PROVIDER")`
(non-null) and is validated against the enum at ingestion time. Unknown sources
are rejected.

## 8.6.2 — Measurement freshness

The decision engine must reject stale measurements. Freshness is computed from
`capturedAt` at ingestion time and persisted (so a historical measurement stays
historical).

```
FRESH    age < 30s
STALE    30s ≤ age < 120s
EXPIRED  age ≥ 120s
```

Thresholds are policy-overridable (`freshnessFreshMs`, `freshnessStaleMs`). A
**stale** measurement must not trigger an automatic switch as though it were
current — it can inform health but cannot be the sole trigger. An **expired**
measurement is excluded from health derivation entirely.

## 8.6.3 — Hysteresis on persisted observations (genuine control-system property)

M-of-N degradation moves out of inline decision-engine logic and into a
persisted `ResourceHealth` snapshot. This makes hysteresis a real
control-system property: the health of a resource is queryable, auditable, and
derived from the measurement stream — not recomputed ad hoc.

```
last N measurements (within window, EXPIRED excluded)
        │
        ▼
per-sample quality derivation  (normalized 0–1)
        │
        ▼
M-of-N degraded  →  status = DEGRADED
        │
        ▼
persisted ResourceHealth { status, quality, sampleCount, degradedCount, freshness }
        │
        ▼
decision engine consults the snapshot
```

The control-system gates already in the decision engine (minimum improvement
margin, dwell, cooldown) now consume the persisted snapshot rather than raw
measurements.

## 8.6.4 — Re-evaluation triggers (event-driven, not blind polling)

Re-evaluation is event-driven. Events are persisted (`ReevaluationEvent`) so a
worker can process them durably; for the synchronous path the ingestion layer
processes them inline.

```
MEASUREMENT_RECEIVED
RESOURCE_DEGRADED
RESOURCE_RECOVERED
QUOTA_THRESHOLD_REACHED
PROVIDER_UNAVAILABLE
LOCATION_CHANGED
POLICY_CHANGED
```

```
event
  │
  ▼
is reevaluation necessary?  (affects an ACTIVE session?)
  │ yes
  ▼
decision engine  →  action  →  executor
```

This is the foundation that will eventually let the mobile agent remain
lightweight: it does not poll, it reacts to trustworthy events.

## Schema drift correction (blocking the runtime loop)

**Finding:** `ConnectivityEntitlement` has **no `userId` column** in PostgreSQL,
yet the kernel-bridge (`resolveResourceBinding`) and the invariant checker both
query `entitlement.userId`. A direct runtime query confirms Prisma rejects it.
This means the ACTIVATE/SWITCH/recovery paths have **never executed against a
database** — every Phase 8.5 test was static source inspection.

**Fix (additive, no kernel-code change):** add `userId String?` +
`@@index([userId])` to `ConnectivityEntitlement`. The frozen kernel
(`entitlement.ts`) does not write `userId` (it passes it only to the audit log),
so existing kernel-created entitlements remain `userId = NULL`. The control
plane's user-scoped queries become runnable, and entitlements created with a
`userId` (user-scoped flows, test fixtures) are correctly associated.

This is a schema correction to match the control plane's existing contract — it
does not modify the frozen kernel code, the adapter contract, the ranking
engine, or the ledger.

## North-star runtime test (DB-backed)

```
Fixture: Tenant, Subscription, ConnectivityCapability(INTERNET),
         ProtocolCapability A + Resource A (AVAILABLE, healthy spec),
         ProtocolCapability B + Resource B (AVAILABLE, healthy spec),
         entitlement (userId=subject) + binding (BOUND, mock adapter).

1. createSession(subject)  →  makeDecision  →  ACTIVATE A
   executeAction  →  kernel bridge  →  mock adapter provision  →  A IN_USE
   invariant holds  →  Session A ACTIVE

2. inject 3 degraded measurements on A (source=ADAPTER, throughput low)
   ingestMeasurement ×3  →  deriveResourceHealth(A)  →  DEGRADED
   ReevaluationEvent(MEASUREMENT_RECEIVED) emitted

3. triggerReevaluation  →  makeDecision  →  SWITCH B
   policy ALLOW  →  executeAction  →  kernel bridge  →  mock adapter provision B
   B IN_USE, A AVAILABLE (released)  →  invariant holds  →  Session B ACTIVE
```

## Recovery runtime test (DB-backed)

```
1. ACTIVATE A succeeds (provider active, action SUCCEEDED)
2. Simulate crash: set a second action to EXECUTING with executedAt < stale cutoff
3. recoverStaleActions()  →  claims it (RECOVERY_CLAIMED)
4. provider reconcile = ACTIVE  →  verifyResourceUsable = USABLE
5. invariant holds  →  action SUCCEEDED, session converges
```

## Frozen layers (unchanged)

- Connectivity kernel (`entitlement.ts`) — FROZEN.
- Provider adapter contract (`adapter.ts`) — FROZEN.
- Ranking engine — FROZEN.
- Double-entry ledger — FROZEN.

The decision engine is **refactored** (not frozen) to consult the persisted
health snapshot and enforce freshness gating. The action executor, kernel
bridge, and invariant checker are **unchanged** in logic (they already exist and
are correct in source) — they are now *exercised* by runtime tests.
