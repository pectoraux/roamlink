# Phase 12.4.6 — Data Retention Policy

## Policy

RoamLink retains operational data for the minimum period necessary for:
1. Auditability (proving what happened)
2. Reconciliation (recovering from failures)
3. Incident investigation (tracing causal chains)
4. Legal/compliance obligations

## Retention table

| Data Type | Retention | Rationale | Cleanup |
|---|---|---|---|
| ProviderOperationRecord | 90 days | Operational audit trail for provider mutations | Cron deletes records older than 90 days |
| ReevaluationEvent (terminal) | 30 days | Event lifecycle audit | Cron deletes COMPLETED/FAILED/DEAD_LETTER events older than 30 days |
| ReevaluationEvent (PENDING) | Indefinite | Active work queue | Never auto-delete pending work |
| ConnectivityMeasurement | 90 days | Telemetry for health derivation | Cron deletes measurements older than 90 days |
| ResourceHealth | 90 days | Derived health snapshots | Cron deletes health records older than 90 days |
| AuditLog | 7 years | Legal/compliance | Never auto-delete |
| IdempotencyOperation (terminal) | 30 days | Idempotency replay window | Cron deletes COMPLETED/FAILED records older than 30 days |
| Sessions (browser) | 30 days | Session TTL | Existing expiry mechanism |
| Intent history | 90 days | Causal chain audit | Cron deletes SUPERSEDED/EXPIRED/CANCELLED intent records older than 90 days |
| RateLimitEvent | 5 minutes | Sliding window rate limit | Pruned by connectivity-reconcile cron |
| ConnectivityDecision (terminal) | 90 days | Decision audit trail | Cron deletes EXECUTED/FAILED/SKIPPED records older than 90 days |
| ConnectivityAction (terminal) | 90 days | Action audit trail | Cron deletes SUCCEEDED/FAILED records older than 90 days |

## Tenant offboarding

When a tenant is offboarded:
1. All tenant-scoped data is deleted via `onDelete: Cascade` on the Tenant model
2. The tenant record itself is marked `status=inactive` (not deleted — audit trail)
3. API keys are revoked (not deleted — audit trail)
4. Active sessions are terminated

## User deletion (GDPR)

When a user requests deletion:
1. User record is anonymized (email → `deleted-{userId}@deleted.local`, name → "Deleted User")
2. Password hash is cleared
3. All tenant memberships are revoked
4. User-created data (intents, decisions, actions) retains the `subjectId` reference
   (the data belongs to the tenant, not the user — anonymization is sufficient)
5. API keys created by the user are revoked

## Dead-letter retention

Dead-lettered events (EVENT_MAX_ATTEMPTS=5) and decisions (DECISION_MAX_ATTEMPTS=5):
- Retained for 30 days for investigation
- After 30 days, automatically deleted by the cleanup cron
- An operator can manually re-queue a dead-lettered event before deletion

## STARTED provider operation retention

STARTED ProviderOperationRecords are:
- Retained indefinitely until resolved (terminal or recovery)
- Recovery worker runs every 5 minutes (via connectivity-reconcile cron)
- If a STARTED record persists for >30 days without resolution, an alert is emitted
  (via the monitoring contract — see monitoring.md)

## Implementation status

- [ ] Retention cleanup crons NOT YET IMPLEMENTED
- [ ] Tenant offboarding procedure NOT YET IMPLEMENTED
- [ ] User deletion (GDPR) procedure NOT YET IMPLEMENTED
- [ ] Dead-letter cleanup NOT YET IMPLEMENTED

This document defines the POLICY. Implementation is a future phase.
