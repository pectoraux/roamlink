#!/usr/bin/env bash
# Phase 12.4.6.3.3 — Local test database setup helper.
#
# Starts an isolated PostgreSQL 16 container (if Docker is available) and
# exports DATABASE_TEST_URL / DIRECT_TEST_URL for the current shell.
#
# Usage:
#   source scripts/setup-local-test-db.sh   # exports env vars in current shell
#   bash scripts/setup-local-test-db.sh      # prints instructions (no export)
#
# If Docker is unavailable, prints instructions for manual setup.

set -euo pipefail

CONTAINER_NAME="roamlink-test-db"
PG_PORT="5433"
PG_USER="test"
PG_PASSWORD="test"
PG_DB="roamlink_test"

if ! command -v docker &>/dev/null; then
  echo "================================================================================"
  echo "[setup-local-test-db] Docker is not available."
  echo ""
  echo "  To run DB-backed tests locally, you need an isolated PostgreSQL database."
  echo "  Options:"
  echo ""
  echo "  A. Install Docker, then re-run this script."
  echo ""
  echo "  B. Create a Neon branch and add to your .env:"
  echo "     DATABASE_TEST_URL=\"postgresql://USER:PASS@BRANCH-pooler.REGION.aws.neon.tech/test?sslmode=require\""
  echo "     DIRECT_TEST_URL=\"postgresql://USER:PASS@BRANCH.REGION.aws.neon.tech/test?sslmode=require\""
  echo ""
  echo "  C. Use CI (GitHub Actions) — see .github/workflows/ci.yml"
  echo ""
  echo "  See docs/LOCAL-DEVELOPER-DATABASE-SETUP.md for details."
  echo "================================================================================"
  exit 1
fi

# Check if container already exists.
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "[setup-local-test-db] Starting existing container '${CONTAINER_NAME}'..."
  docker start "${CONTAINER_NAME}" >/dev/null
else
  echo "[setup-local-test-db] Creating PostgreSQL 16 container '${CONTAINER_NAME}' on port ${PG_PORT}..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -e POSTGRES_USER="${PG_USER}" \
    -e POSTGRES_PASSWORD="${PG_PASSWORD}" \
    -e POSTGRES_DB="${PG_DB}" \
    -p "${PG_PORT}:5432" \
    postgres:16 >/dev/null
fi

# Wait for PostgreSQL to be ready.
echo "[setup-local-test-db] Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
  if docker exec "${CONTAINER_NAME}" pg_isready -U "${PG_USER}" -d "${PG_DB}" &>/dev/null; then
    echo "[setup-local-test-db] PostgreSQL is ready."
    break
  fi
  sleep 1
done

# Export env vars (only works if sourced).
export DATABASE_TEST_URL="postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
export DIRECT_TEST_URL="postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"

echo ""
echo "[setup-local-test-db] Test database ready."
echo "  DATABASE_TEST_URL=${DATABASE_TEST_URL}"
echo "  DIRECT_TEST_URL=${DIRECT_TEST_URL}"
echo ""
echo "  Next steps:"
echo "    npx prisma migrate deploy"
echo "    bun run prisma/seed.ts"
echo "    bun -e \"import { seedSaaasPlans } from './src/lib/tenant/entitlements'; import { seedConnectivityCapabilities } from './src/lib/connectivity/entitlement'; await seedSaaasPlans(); await seedConnectivityCapabilities();\""
echo "    bun run test:postgres"
echo ""
echo "  NOTE: If this script was not sourced, the env vars are not exported."
echo "        Run: source scripts/setup-local-test-db.sh"
