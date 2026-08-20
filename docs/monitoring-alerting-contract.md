# Phase 12.4.6 — Monitoring & Alerting Contract

## Minimum production signals

These signals must be emitted (via structured logs) for production monitoring.

### Worker health

| Signal | Log event | Severity | Alert threshold |
|---|---|---|---|
| Worker failure | `cron.*.failed` | ERROR | Any occurrence |
| Worker absence | (no log emitted) | WARN | No `cron.*.completed` in 10 minutes |
| Reconciliation backlog | `cron.*.completed` with `recovered > 0` | INFO | `recovered > 10` in a single cycle |
| STARTED operations | `provider_operation.recovery_*` | WARN | `examined > 50` in a single cycle |

### Provider health

| Signal | Log event | Severity | Alert threshold |
|---|---|---|---|
| Provider failure | `mikrotik.*_failed` | ERROR | >5 failures in 5 minutes |
| Provider unavailable | `provider_operation.recovery_retained` | WARN | >3 retained in a single cycle |
| Provider operation recovery | `provider_operation.recovery_completed` | INFO | (no alert) |

### Payment health

| Signal | Log event | Severity | Alert threshold |
|---|---|---|---|
| Payment ambiguity | `idempotency.reconciliation_required` | ERROR | Any occurrence |
| Payment failure | `payment.failed` | ERROR | >3 failures in 5 minutes |
| Idempotency conflict | `idempotency.conflict` | WARN | Any occurrence |

### Rate limiting

| Signal | Log event | Severity | Alert threshold |
|---|---|---|---|
| Rate limit exceeded | `rate_limit.exceeded` | WARN | >100 per minute per tenant |
| Rate limit infrastructure failure | `rate_limit.insert_failed` | ERROR | Any occurrence |

### Dead-letter growth

| Signal | Log event | Severity | Alert threshold |
|---|---|---|---|
| Event dead-lettered | `reevaluation.event_dead_lettered` | ERROR | Any occurrence |
| Decision dead-lettered | `decision.dead_lettered` | ERROR | Any occurrence |

### Database health

| Signal | Log event | Severity | Alert threshold |
|---|---|---|---|
| DB error | `api.error` with `statusCode >= 500` | ERROR | Any occurrence |
| DB connection failure | (Prisma throws) | ERROR | Any occurrence |

## Implementation status

- [ ] Structured log events are emitted by the codebase (DONE — all signals above use existing logger calls)
- [ ] External alerting system integration: NOT YET CONFIGURED
- [ ] Worker absence detection: NOT YET IMPLEMENTED (requires external scheduler monitoring)
- [ ] Dashboard: NOT YET IMPLEMENTED

The `/api/internal/ops` endpoint returns a real-time operational state summary
that can be consumed by an external monitoring system (Datadog, Grafana, etc.).
The structured log events are emitted via `@/lib/logger` and can be consumed
by Vercel Logs or any log aggregation system.

This document defines the CONTRACT. External integration is a deployment-time task.
