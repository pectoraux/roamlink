# Local Developer Database Setup

## The Safety Contract

The test suite contains `deleteMany`, schema migrations, cleanup, destructive
fixtures, and concurrency tests. It **MUST NEVER** connect to the production
database. The safety guard (`tests/safety-guard.ts`) enforces this — tests
fail immediately if `DATABASE_TEST_URL` is missing.

```
No DATABASE_TEST_URL
    ↓
DB tests fail immediately (before any query)
```

**Do NOT make local developers accidentally use production.**

---

## Obtaining `DATABASE_TEST_URL` + `DIRECT_TEST_URL` Locally

### Option A — Local PostgreSQL via Docker (recommended)

```bash
# Start an isolated PostgreSQL 16 container on port 5433 (avoid conflicts).
docker run -d \
  --name roamlink-test-db \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=roamlink_test \
  -p 5433:5432 \
  postgres:16

# Add to your .env (NOT committed):
DATABASE_TEST_URL="postgresql://test:test@localhost:5433/roamlink_test"
DIRECT_TEST_URL="postgresql://test:test@localhost:5433/roamlink_test"
```

### Option B — Neon branch (for teams without Docker)

1. Create a Neon branch from your project (Neon dashboard or `neonctl`).
2. Use the branch's connection string as `DATABASE_TEST_URL`.
3. The branch is isolated from your main/production database.

```bash
DATABASE_TEST_URL="postgresql://USER:PASS@BRANCH-pooler.REGION.aws.neon.tech/test?sslmode=require"
DIRECT_TEST_URL="postgresql://USER:PASS@BRANCH.REGION.aws.neon.tech/test?sslmode=require"
```

### Option C — CI (GitHub Actions)

CI provisions an ephemeral PostgreSQL 16 service container per workflow run.
No credentials required — the runner manages the lifecycle. See
`.github/workflows/ci.yml`.

---

## Local Test Commands

```bash
# Safety tests (no DB required — pure guard logic)
bun run test:safety

# Unit tests (no DB required)
bun run test:unit

# PostgreSQL authority suite (requires DATABASE_TEST_URL)
bun run test:postgres

# Authority matrix only (6 tests, requires DATABASE_TEST_URL)
bun run test:authority

# Smoke tests (requires DATABASE_TEST_URL)
bun run test:smoke

# All tests (requires DATABASE_TEST_URL for DB-backed tests)
bun run test:all
```

---

## Local Setup Workflow

```bash
# 1. Install dependencies
bun install

# 2. Generate Prisma client
bun run db:generate

# 3. Set up isolated test database (Option A or B above)

# 4. Deploy migrations to the test database
npx prisma migrate deploy

# 5. Seed the test database
bun run prisma/seed.ts
bun -e "
  import { seedSaaasPlans } from './src/lib/tenant/entitlements';
  import { seedConnectivityCapabilities } from './src/lib/connectivity/entitlement';
  await seedSaaasPlans();
  await seedConnectivityCapabilities();
"

# 6. Run tests
bun run test:postgres
```

---

## Safety Guarantees

The test harness enforces:

1. `DATABASE_TEST_URL` is mandatory for DB-backed tests.
2. `DATABASE_TEST_URL` must NOT equal `DATABASE_URL`.
3. `DATABASE_TEST_URL` must NOT point to the same host as `DATABASE_URL`.
4. `VERCEL_ENV=production` → tests refuse to start.
5. `NODE_ENV=production` → tests refuse to start.
6. `DATABASE_TEST_URL` must be PostgreSQL (not SQLite).

If any check fails, the test process exits before any DB query is made.

**SQLite is NOT used as a substitute for PostgreSQL concurrency proof.**
