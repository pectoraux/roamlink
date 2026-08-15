# Phase 2C.4.10 / 2C.4.11 — Live & Distributed Validation Plan

## Validation Status (honest labels)

```
2C.4.5 – 2C.4.9:    MOCK-VALIDATED (Neon PostgreSQL + MockRouterOSTransport)
2C.4.10:            PREPARED — NOT EXECUTED (no live RouterOS available)
2C.4.11:            NOT STARTED (no multi-process infrastructure available)
```

## Phase 2C.4.10 — Live RouterOS Compatibility

### Prerequisites
- A MikroTik router running RouterOS v7+ with:
  - REST API enabled (`/rest` endpoint under IP → Services → www)
  - HTTPS configured (or HTTP for local testing)
  - A HotSpot interface configured
  - Admin credentials
- OR a RouterOS CHR (Cloud Hosted Router) container/image
- Environment variables:
  ```
  LIVE_ROUTEROS_ENDPOINT=https://<router-ip>/rest
  LIVE_ROUTEROS_USERNAME=admin
  LIVE_ROUTEROS_PASSWORD=<password>
  LIVE_ROUTEROS_ALLOW_INSECURE_TLS=true  (for self-signed certs)
  ```

### Test Matrix (in tests/phase2c410-live-routeros.test.ts)

1. **Authentication**
   - 1a: valid credentials → 200 on GET /system/resource
   - 1b: wrong credentials → 401
   - 1c: credential rotation → cache invalidation

2. **Resource identity**
   - 2a: `rl-<binding-id>` username accepted by RouterOS
   - 2b: `.id` vs username distinction (GET/PATCH/DELETE by .id, lookup by ?name=)

3. **Create semantics**
   - 3a: GET absent → PUT creates
   - 3b: GET existing → converge without PUT
   - 3c: PUT timeout → GET reconciliation
   - 3d: PUT 409 → GET reconciliation (concurrent PUTs)
   - 3e: concurrent PUTs → exactly one resource

4. **Actual RouterOS response behavior**
   - 4a: real HTTP status codes for all operations
   - 4b: real error payloads (malformed request, missing fields)
   - 4c: real timeout behavior
   - 4d: actual duplicate-name behavior (CRITICAL — determines if CONFLICT path is exercised)
   - 4e: actual response representation (field names, formats)

5. **Recovery**
   - 5a: external resource created, local commit lost → recovery GET finds it
   - 5b: expired lease → recovery creates the resource

6. **Negative cases**
   - 6a: authentication failure → fail closed
   - 6b: network interruption → RETRYABLE
   - 6c: provider unavailable → fail closed

7. **Evidence**
   - RouterOS version recorded from /system/resource
   - Every HTTP operation logged with method, path, status, duration
   - External resource count verified against the live router
   - Cleanup: all test users deleted after each test

### Critical unknown to resolve

**4d: actual duplicate-name behavior.** The mock's `strictConflictMode` assumes RouterOS returns HTTP 409 when PUT targets an existing username. The real behavior may differ — RouterOS might return 400, or silently return the existing resource. Test 4d documents the actual behavior, which determines whether the CONFLICT reconciliation path in `createResource()` is ever exercised against a real router, or whether the GET-first idempotency path handles all cases.

## Phase 2C.4.11 — Multi-Process Distributed Validation

### Prerequisites
- Two genuinely independent worker processes/containers
- Shared PostgreSQL database (Neon or local)
- Shared RouterOS endpoint (live or CHR)
- Network control tools (tc, iptables, or Docker networking) for:
  - Network partition simulation
  - Latency injection
  - Connection-pool pressure

### Test Matrix

1. **Simultaneous provisioning** — two processes call `provisionBinding(bindingId)` concurrently
2. **Lease takeover** — process A claims, process B takes over after expiry
3. **Heartbeat vs takeover race** — A's heartbeat vs B's takeover, only one wins
4. **Stale-worker finalization** — A tries to finalize after B took over
5. **Process death after PUT** — A creates resource, dies before BOUND; B reconciles
6. **Process death before PUT** — A claims, dies; B creates from scratch
7. **Network partition between worker and RouterOS** — A's PUT is in flight when the network drops
8. **Database latency** — inject artificial DB delay, verify lease/heartbeat behavior
9. **Connection-pool pressure** — many concurrent operations, verify no pool exhaustion
10. **Clock skew** — verify the lease/heartbeat system tolerates clock differences
11. **Concurrent reconciliation workers** — two processes call `reconcileProvisioning` simultaneously

### Evidence requirements

- Process A and Process B logs are interleaved and timestamped
- Every DB mutation is logged with the process ID
- Every RouterOS operation is logged with the process ID
- The final external resource count is verified independently
- The final binding state is verified by a third observer

## Why these cannot be executed in the current environment

- **No Docker**: `docker` is not available, so RouterOS CHR cannot be run locally.
- **No physical router**: no MikroTik device is accessible.
- **Single process**: all tests run in a single Bun process against Neon.
- **No network control**: `tc`, `iptables`, and Docker networking are not available for partition/latency simulation.

These are infrastructure limitations, not architecture limitations. The code is designed for these conditions; the validation simply requires infrastructure that is not present in this development environment.
