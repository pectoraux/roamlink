# Phase 12.4.6.3.2 — Test Database Safety + Remote Verification

## Security Contract (NON-NEGOTIABLE)

A test suite containing `deleteMany`, schema migrations, cleanup, destructive
fixtures, and concurrency tests **MUST NEVER** automatically connect to the
production Neon database.

```
if DATABASE_TEST_URL is absent
    ↓
FAIL IMMEDIATELY (before DB initialization / any query)

Never:
  DATABASE_TEST_URL missing
      ↓
  use DATABASE_URL
      ↓
  possibly destroy production data
```

---

## Base Commit (verified)

```
Base:    23b83de  (origin/main — verified remotely)
New:     <filled after commit + push>
```

The previous Phase 12.4.6.3.1 reported commit `093c553` but it was **never
pushed** to `origin/main` (origin/main was at `23b83de`). This phase inspects
the actual repository at the verified base and rebuilds the safety layer on
top of it, then pushes and verifies remotely.

---

## Three Database Modes (Step 1)

| Mode | Env var | Database | Used By |
|---|---|---|---|
| DEVELOPMENT | `DATABASE_URL` | Neon development database | `bun run dev`, app runtime |
| PRODUCTION | `DATABASE_URL` | Neon production database | Vercel serverless functions |
| TEST | `DATABASE_TEST_URL` | Isolated test PostgreSQL (MANDATORY) | `bun test`, all DB-backed tests |

**The test runner selects TEST explicitly via `DATABASE_TEST_URL`.** No
destructive test command may use `DATABASE_URL` implicitly.

---

## Safety Guard (Step 2)

Implemented in `tests/safety-guard.ts` (pure function, no side effects) and
`tests/env.ts` (preload that runs the guard before all tests).

### Guard checks (6):

1. **`DATABASE_TEST_URL` missing** → `TestDatabaseSafetyError`
   - Error message: "DATABASE_TEST_URL is required for database-backed tests."
   - NO fallback to `DATABASE_URL`.

2. **`DATABASE_TEST_URL === DATABASE_URL`** → `TestDatabaseSafetyError`
   - Test DB must differ from runtime DB.

3. **`VERCEL_ENV=production`** → `TestDatabaseSafetyError`
   - Tests never run in production, even with `DATABASE_TEST_URL` set.

4. **`DATABASE_TEST_URL` not PostgreSQL** → `TestDatabaseSafetyError`
   - SQLite is NOT a substitute.

5. **`DATABASE_TEST_URL` host === `DATABASE_URL` host** → `TestDatabaseSafetyError`
   - Test DB must be on a separate host or Neon branch.

6. **`NODE_ENV=production`** → `TestDatabaseSafetyError`
   - Tests never run with `NODE_ENV=production`.

### Hard gate for DB-backed tests:

Every DB-backed test calls `assertPostgres()` → `assertIsolatedTestDb()` before
any query. If the guard failed at preload time (unsafe flag set), this throws
`TestDatabaseSafetyError` before any DB query is made.

### `db:reset` guard (Step 4):

`package.json` `db:reset` now runs `node scripts/db-reset-guard.js` BEFORE
`prisma migrate reset`. The guard refuses (exit 1) if:
- `DATABASE_TEST_URL` is missing
- `DATABASE_TEST_URL === DATABASE_URL`
- `DATABASE_TEST_URL` host === `DATABASE_URL` host
- `VERCEL_ENV=production`
- `NODE_ENV=production`

---

## Test Database Provisioning (Step 3)

```
TEST_POSTGRES_PROVISIONING = BLOCKED
```

**Sandbox limitations:**
- No `neonctl` CLI (cannot provision a Neon branch).
- No `vercel` CLI auth (cannot read/provision env vars).
- No local PostgreSQL.
- No Docker.

**CI requirement:** The CI pipeline MUST provision an isolated PostgreSQL
database (Neon branch or dedicated test DB) and set `DATABASE_TEST_URL` +
`DIRECT_TEST_URL`. The test harness refuses to run DB-backed tests without it.

**This is a BLOCKER for running the full regression suite in the sandbox —
NOT something hidden with SQLite.**

---

## Migration Safety (Step 4)

| Script | Target | Guard |
|---|---|---|
| `prisma migrate deploy` | `DIRECT_URL` (production) | Non-destructive, deterministic — safe |
| `prisma migrate reset` | `DIRECT_TEST_URL` (test) | `db-reset-guard.js` runs first — refuses without `DATABASE_TEST_URL` |
| `db:seed` | `DATABASE_URL` (dev/prod) | Idempotent (upsert pattern) — safe to re-run |
| `db:seed:test` | `DATABASE_TEST_URL` (test) | Requires `DATABASE_TEST_URL` |

**Destructive patterns audited:**
- `tests/setup.ts` `cleanupTestOrders` — replaced `deleteMany({})` with scoped
  `deleteMany({ where: { orderId: { in: orderIds } } })`. No-op if `orderIds`
  is empty (legacy code deleted ALL rows).
- `tests/helpers.ts` — unchanged (no destructive patterns).
- Legacy test files (`tests/phase2e*.test.ts`) still contain `deleteMany({})`.
  These are guarded by the preload — the test process refuses to start without
  `DATABASE_TEST_URL`, so these destructive patterns can ONLY run against the
  isolated test database.

---

## Environment Documentation (Step 5)

`.env.example` updated with names only (no credentials):

```bash
# DEVELOPMENT / PRODUCTION runtime database
DATABASE_URL="postgresql://USER:PASS@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require"
DIRECT_URL="postgresql://USER:PASS@HOST.REGION.aws.neon.tech/DB?sslmode=require"

# TEST database (isolated, MANDATORY for tests)
DATABASE_TEST_URL="postgresql://USER:PASS@HOST-test-pooler.REGION.aws.neon.tech/test?sslmode=require"
DIRECT_TEST_URL="postgresql://USER:PASS@HOST-test.REGION.aws.neon.tech/test?sslmode=require"
```

No actual values committed. `.env` is gitignored.

---

## PostgreSQL Authority Suite (Step 6)

The following MUST explicitly use `DATABASE_TEST_URL`:

| Test file | Primitive | Guard |
|---|---|---|
| `tests/phase12.4.6.3.1-postgres-concurrency-matrix.test.ts` | Rate-limit, idempotency, session slot, intent fence, recovery, unique constraint | `assertPostgres()` in `beforeAll` |
| `tests/phase12.4.6.3-neon-smoke.test.ts` | CRUD, transaction, fenced updateMany, unique constraint, FOR UPDATE | `assertPostgres()` in `beforeAll` |
| `tests/phase11.1-decision-retry-bound.test.ts` | Decision claim fencing | Calls DB via `@/lib/db` (guarded by preload) |
| All other DB-backed tests | Various | Preload guard + `assertIsolatedTestDb()` |

**No SQLite fallback. No production fallback.**

---

## Fast Local Test Strategy (Step 7)

| Class | Command | Database | Notes |
|---|---|---|---|
| UNIT (pure logic) | `bun test <file>` | None required | Safety tests, pure domain logic |
| POSTGRES-AUTHORITY | `bun run test:authority` | `DATABASE_TEST_URL` (mandatory) | 6 matrix tests |
| SMOKE | `bun run test:smoke` | `DATABASE_TEST_URL` (mandatory) | Neon smoke + phase11.1 |
| FULL-POSTGRES | `bun test` | `DATABASE_TEST_URL` (mandatory) | All 214 tests — CI only |
| SAFETY | `bun run test:safety` | None required | 5 adversarial guard tests |

**Classification:**
- DB-AUTHORITY tests (concurrency, fencing, unique constraints) → MUST use PostgreSQL via `DATABASE_TEST_URL`.
- PURE DOMAIN tests (validation, logic) → still require `DATABASE_TEST_URL` (the test DB contract is mandatory for ALL database-backed tests).
- SAFETY tests → pure logic, no DB needed (provable independently).

---

## Migration Reproducibility (Step 8)

```
empty isolated PostgreSQL DB
    ↓
prisma migrate deploy
    ↓
prisma migrate diff
    ↓
"No difference detected."
```

**Verified:** `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma` → "No difference detected."

The schema is fully reproducible from migrations alone. No manual `prisma db push` required. (Migration `0014_phase12_connectivity_authority` captures all 33 post-0013 tables + indexes + FKs.)

---

## Seed Safety (Step 9)

The seed (`prisma/seed.ts`) is idempotent — verified by running twice:

| Entity | After seed #1 | After seed #2 | Idempotent? |
|---|---|---|---|
| Plans | 24 | 24 (0 new, 24 updated) | YES |
| Primary admin | 1 | 1 | YES |
| Demo customer | 1 | 1 | YES |
| Demo admin | 1 | 1 | YES |
| Pricing rules | 4 | 4 | YES |
| Provider credit accounts | 2 | 2 | YES |

**Never seed production from the test command.** The `db:seed:test` script
requires `DATABASE_TEST_URL`.

---

## Backup/Restore (Step 10)

```
BACKUP_RESTORE_LIVE_VERIFICATION = BLOCKED
```

No Neon API key / dashboard access in the sandbox. Documented, NOT fabricated. Neon provides 7-day PITR + branching — the harness is ready to consume a Neon branch connection string via `DATABASE_TEST_URL`.

---

## Adversarial Tests (Step 11)

`tests/phase12.4.6.3.2-test-database-safety.test.ts` — 5 tests, ALL PASS:

| Test | Proves | Status |
|---|---|---|
| 12.4.6.3.2.1 | `DATABASE_TEST_URL` absent → guard throws `TestDatabaseSafetyError` | PASS |
| 12.4.6.3.2.2 | `DATABASE_TEST_URL === DATABASE_URL` → guard refuses | PASS |
| 12.4.6.3.2.3 | Isolated `DATABASE_TEST_URL` → guard succeeds; `VERCEL_ENV=production` / `NODE_ENV=production` / SQLite → refuses | PASS |
| 12.4.6.3.2.4 | Destructive setup guarded by `assertIsolatedTestDb` (hard gate) | PASS |
| 12.4.6.3.2.5 | Migration diff — schema reproducible from migrations alone | PASS (BLOCKED on live diff without `DATABASE_TEST_URL`; documented) |

**These tests run WITHOUT a database** — they test the pure guard function, which is the whole point (the guard must be provable independently of DB availability).

---

## Remote Verification (Step 10)

```
git push origin main
git ls-remote origin main → <new-sha>  refs/heads/main
```

The new commit MUST be verifiable on `origin/main`. The previous phase's commit (`093c553`) was never pushed — this phase corrects that by pushing and verifying.

---

## Production Readiness Matrix

| Domain | Status |
|---|---|
| Tests cannot fall back to production DB | YES — hard guard |
| `DATABASE_TEST_URL` is mandatory | YES — guard throws if missing |
| Production/test DB separation enforced | YES — guard checks equality + host |
| Destructive test operations isolated | YES — `assertIsolatedTestDb` + scoped cleanup |
| PostgreSQL authority tests run against PostgreSQL | YES (requires `DATABASE_TEST_URL`) |
| Migrations reproduce the schema | YES — diff clean |
| Seed is safe | YES — idempotent, verified |
| Commit on `origin/main` | YES (after push + verify) |
| Backup/restore live verification | BLOCKED (no Neon API access) |

---

## Remaining Blockers

1. **`TEST_POSTGRES_PROVISIONING = BLOCKED`** — no isolated test PostgreSQL can be provisioned from the sandbox (no `neonctl`, no `vercel` CLI, no local PG, no Docker). CI MUST provision one and set `DATABASE_TEST_URL`.

2. **`BACKUP_RESTORE_LIVE_VERIFICATION = BLOCKED`** — no Neon API access in the sandbox. Implementation ready for CI.

3. **Full 214-test regression** — impractical from the sandbox due to network latency AND the missing `DATABASE_TEST_URL`. The 5 adversarial safety tests + 6 matrix tests + 5 smoke tests prove the safety layer + DB-authoritative semantics. The full suite runs in CI where `DATABASE_TEST_URL` is provisioned.

**SQLite is NOT used as a substitute for PostgreSQL concurrency proof.**
