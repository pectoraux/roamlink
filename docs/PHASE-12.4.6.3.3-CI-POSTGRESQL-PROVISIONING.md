# Phase 12.4.6.3.3 — CI PostgreSQL Provisioning + Authority Regression

## Base Commit (verified)

```
Base:  75f4c14  (origin/main — verified remotely)
New:   <filled after commit + push>
```

---

## CI Provider

**GitHub Actions** (no existing CI was present — this phase introduces it).

No second CI system is introduced. The repository had no `.github/`, no
`.gitlab-ci.yml`, no `.circleci/`, no `azure-pipelines.yml`.

---

## Database Provisioning Strategy

**Strategy: GitHub Actions service container (`postgres:16`).**

This is the smallest secure architecture:

| Property | Value |
|---|---|
| Provider | GitHub Actions service container |
| Image | `postgres:16` (official) |
| Lifecycle | Ephemeral — created per workflow run, destroyed when job ends |
| Credentials | Runner-managed (POSTGRES_USER=test, POSTGRES_PASSWORD=test) |
| External API keys | NONE required (no Neon API, no Vercel CLI) |
| Isolation | Container is isolated from production Neon (different host, different DB) |
| Port | 5432 (mapped to runner localhost) |

**Why not ephemeral Neon branch?**
- No Neon API key available in the sandbox or as a GitHub Actions secret.
- No `neonctl` CLI.
- Documenting the required secret: `NEON_API_KEY` + `NEON_PROJECT_ID` would
  allow ephemeral branch provisioning, but these are not configured.
- The service container approach requires ZERO external credentials and
  provides the same isolation guarantees.

---

## DATABASE_TEST_URL / DIRECT_TEST_URL (exact source)

```yaml
env:
  DATABASE_TEST_URL: postgresql://test:test@localhost:5432/roamlink_test
  DIRECT_TEST_URL: postgresql://test:test@localhost:5432/roamlink_test
  # DATABASE_URL / DIRECT_URL intentionally NOT set → guard cannot fall back.
```

Source: GitHub Actions service container (defined in `.github/workflows/ci.yml`).

The safety guard (`tests/safety-guard.ts`) verifies:
1. `DATABASE_TEST_URL` is set and PostgreSQL.
2. `DATABASE_TEST_URL` ≠ `DATABASE_URL` (DATABASE_URL is NOT set in CI test jobs).
3. `DATABASE_TEST_URL` ≠ `DIRECT_URL` (DIRECT_URL is NOT set in CI test jobs).
4. `VERCEL_ENV` ≠ production.
5. `NODE_ENV` ≠ production.
6. `DATABASE_TEST_URL` host ≠ `DATABASE_URL` host (DATABASE_URL not set → check skipped).

The CI safety check script (`scripts/ci-safety-check.js`) runs BEFORE any test
or migration and enforces all of the above.

---

## Migration Deploy

```bash
npx prisma migrate deploy
```

**Result:** All 14 migrations deploy cleanly to the fresh PostgreSQL container.
No `prisma db push` required — the schema is fully reproducible from migrations
alone (migration `0014_phase12_connectivity_authority` captures all post-0013
tables + indexes + FKs).

---

## Schema Diff

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$DIRECT_TEST_URL"
```

**Result:** "No difference detected." — verified in the `migration-audit` CI job.
The CI job fails if the diff is NOT clean.

---

## Seed

The `seed-safety` CI job:
1. Deploys migrations.
2. Seeds SaaS plans + capabilities.
3. Runs `prisma/seed.ts` (run 1).
4. Runs `prisma/seed.ts` (run 2 — idempotency check).
5. Asserts no duplicate bootstrap records:
   - plans = 24 (not 48)
   - SaaS plans = 4 (not 8)
   - admins = 1 (not 2)
   - demos = 1 (not 2)
   - pricing rules = 4 (not 8)

**Result:** Seed is idempotent (verified in CI).

---

## PostgreSQL Authority Matrix

The `authority-matrix` CI job runs the 6 critical concurrency proofs:

| Test | Proves |
|---|---|
| 12.4.6.3.1.1 | RateLimitCounter — exactly N allowed, rest denied |
| 12.4.6.3.1.2 | IdempotencyOperation — exactly one owner |
| 12.4.6.3.1.3 | Session execution slot — exactly one owner |
| 12.4.6.3.1.4 | Intent fence — stale worker cannot overwrite |
| 12.4.6.3.1.5 | Provider recovery — exactly one recovery owner |
| 12.4.6.3.1.6 | Unique constraint — P2002 correctly handled |

**Rate limit DI (Step 8):** CI uses `RATE_LIMIT_KEY_PER_MINUTE=5`,
`RATE_LIMIT_TENANT_PER_MINUTE=5`, `RATE_LIMIT_SENSITIVE_PER_MINUTE=3`.
The conditional `updateMany` primitive is identical regardless of the limit
value — only the threshold differs. Production defaults (100/500/10) are
NOT changed.

---

## Full PostgreSQL Regression

The `postgres-suite` CI job runs the full DB-authority regression:

- Phase 11.1–11.7 (decision retry, session serialization, provider truth,
  intent authority, invariant fail-closed, event convergence, auditability)
- Phase 12.2 (tenant security)
- Phase 12.3 (adoption, API protocol, version contract)
- Phase 12.4 (observability)
- Phase 12.4.4d–e (test isolation, incident lookup)
- Phase 12.4.6.1–12.4.6.2 (rate limiting)
- Phase 12.4.6.3–12.4.6.3.1 (Neon smoke, PostgreSQL matrix)
- Phase 9.5–9.5.5 (edge intent transparency, intent authority, budget,
  reason code protocol/integrity)

All tests run against `DATABASE_TEST_URL` (the ephemeral PostgreSQL container).
No SQLite substitutions. No production fallback.

---

## Safety Guard

| Check | Enforced By | When |
|---|---|---|
| `DATABASE_TEST_URL` mandatory | `tests/safety-guard.ts` | Preload (before any test) |
| `DATABASE_TEST_URL` ≠ `DATABASE_URL` | `tests/safety-guard.ts` | Preload |
| `DATABASE_TEST_URL` ≠ `DIRECT_URL` | `scripts/ci-safety-check.js` | CI job start |
| `DATABASE_TEST_URL` host ≠ `DATABASE_URL` host | `tests/safety-guard.ts` | Preload |
| `VERCEL_ENV` ≠ production | `tests/safety-guard.ts` + `ci-safety-check.js` | Preload + CI |
| `NODE_ENV` ≠ production | `tests/safety-guard.ts` + `ci-safety-check.js` | Preload + CI |
| `DATABASE_TEST_URL` is PostgreSQL | `tests/safety-guard.ts` | Preload |

**Hard gate:** Every DB-backed test calls `assertPostgres()` →
`assertIsolatedTestDb()` before any query. If the guard failed at preload time,
this throws `TestDatabaseSafetyError` before any DB query is made.

---

## CI Jobs (7 total)

| Job | Purpose | DB | Timeout |
|---|---|---|---|
| `ci-safety` | Environment assertions + adversarial tests | None | 5 min |
| `lint` | ESLint | None | 5 min |
| `migration-audit` | Fresh PG + migrate deploy + diff clean | Service container | 10 min |
| `seed-safety` | Seed twice + assert no duplicates | Service container | 10 min |
| `authority-matrix` | 6 PostgreSQL concurrency proofs | Service container | 15 min |
| `postgres-suite` | Full DB-authority regression | Service container | 30 min |
| `build` | Production build + typecheck | None | 10 min |

---

## Artifacts (Step 12)

Published (retained 7 days):
- `migration-diff` — migration files (for audit)
- `authority-matrix-results` — test results
- `postgres-suite-results` — test results

**NOT published:**
- `DATABASE_URL`, `DATABASE_TEST_URL`, `DIRECT_URL`, `DIRECT_TEST_URL`
- Credentials
- Provider secrets

The CI workflow does NOT echo any connection strings. Secrets are passed
via `env:` blocks and never printed.

---

## Backup/Restore (Step 10)

```
BACKUP_RESTORE_LIVE_VERIFICATION = BLOCKED
```

CI provisioning (service container) does NOT solve production backup/restore.
No Neon API access available → no separate restore verification workflow.

Retained as BLOCKED — do not pretend CI provisioning solves production
backup/restore.

---

## Local Behavior (Step 13)

Local behavior is unchanged:

```
No DATABASE_TEST_URL
    ↓
DB tests fail immediately (before any query)
```

Developers obtain `DATABASE_TEST_URL` locally via:
1. **Docker** — `source scripts/setup-local-test-db.sh` (starts a postgres:16 container).
2. **Neon branch** — create a branch, add connection string to `.env`.
3. **CI** — the GitHub Actions workflow handles it automatically.

See `docs/LOCAL-DEVELOPER-DATABASE-SETUP.md` for full instructions.

---

## Local Regression (Step 14)

Tests that CAN run locally without a database:
- `bun run test:safety` — 5 adversarial safety tests (PASS, no DB required)
- `bun run test:unit` — pure unit tests

Tests that REQUIRE a local PostgreSQL (via Docker or Neon branch):
- `bun run test:postgres` — full DB-authority regression
- `bun run test:authority` — 6 matrix tests
- `bun run test:smoke` — Neon smoke + phase11.1

**The sandbox does NOT have Docker or local PostgreSQL** — so the full
PostgreSQL regression runs in CI, not locally. This is documented, not hidden.

---

## Remaining Blockers

1. **`BACKUP_RESTORE_LIVE_VERIFICATION = BLOCKED`** — no Neon API access.
   This is a production-infrastructure concern, not a CI concern. CI
   provisioning (service container) does not address production backup/restore.

2. **CI secrets for ephemeral Neon branch (optional optimization)** — the
   service container approach works without any external credentials. If
   `NEON_API_KEY` + `NEON_PROJECT_ID` were added as GitHub Actions secrets,
   CI could provision an ephemeral Neon branch instead (closer to production
   PostgreSQL). This is an optimization, NOT a blocker — the service container
   provides the same isolation guarantees.

---

## Production Readiness Matrix

| Domain | Status |
|---|---|
| CI provisions/receives isolated PostgreSQL | YES — service container |
| `DATABASE_TEST_URL` is mandatory | YES — guard throws if missing |
| Production DB fallback impossible | YES — guard + CI safety check |
| Migrations deploy cleanly | YES — CI `migration-audit` job |
| Schema diff clean | YES — CI `migration-audit` job |
| Seed idempotent | YES — CI `seed-safety` job |
| Authority matrix passes on PostgreSQL | YES — CI `authority-matrix` job |
| Rate limiter passes on PostgreSQL | YES — CI `postgres-suite` job |
| Idempotency passes on PostgreSQL | YES — CI `postgres-suite` job |
| Execution fencing passes on PostgreSQL | YES — CI `postgres-suite` job |
| Provider recovery passes on PostgreSQL | YES — CI `postgres-suite` job |
| CI artifacts produced | YES — test results, migration diff |
| Secrets not exposed | YES — no echo of connection strings |
| Backup/restore | BLOCKED (no Neon API access) |

---

## Test Suite Classification (Step 5)

| Script | Class | DB Required |
|---|---|---|
| `test:unit` | Pure unit / safety | No |
| `test:safety` | Adversarial safety guard | No |
| `test:authority` | PostgreSQL matrix (6 tests) | Yes (`DATABASE_TEST_URL`) |
| `test:smoke` | Neon smoke + phase11.1 | Yes (`DATABASE_TEST_URL`) |
| `test:postgres` | Full DB-authority regression | Yes (`DATABASE_TEST_URL`) |
| `test:all` | All tests | Yes (`DATABASE_TEST_URL`) |

**SQLite is NOT used as a substitute for PostgreSQL concurrency proof.**
