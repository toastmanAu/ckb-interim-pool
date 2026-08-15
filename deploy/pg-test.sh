#!/usr/bin/env bash
# Start a local PostgreSQL for integration tests.
# Usage: deploy/pg-test.sh [port]   (default 5433)
set -euo pipefail
PORT="${1:-5433}"
if ! docker ps -a --format '{{.Names}}' | grep -q '^pool-pg-test$'; then
  docker rm -f pool-pg-test >/dev/null 2>&1 || true
  docker run -d --name pool-pg-test \
    -e POSTGRES_PASSWORD=pooltest -e POSTGRES_USER=pool -e POSTGRES_DB=pooltest \
    -p "${PORT}:5432" postgres:16-alpine >/dev/null
  echo "postgres test server on :${PORT}"
else
  docker start pool-pg-test >/dev/null
  echo "postgres test server already running on :${PORT}"
fi
ready=0
for i in $(seq 1 20); do
  if docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "postgres not ready" >&2
  exit 1
fi
# dedicated CI/test database — integration tests must never touch the
# live session database (they truncate their tables at start). The suites
# refuse any database not named as disposable; see test/tools/test-db.js.
docker exec pool-pg-test psql -U pool -d postgres -c "CREATE DATABASE pooltest_ci" >/dev/null 2>&1 || true
docker exec pool-pg-test psql -U pool -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE pooltest_ci TO pool" >/dev/null 2>&1 || true
echo "test database ready: pooltest_ci (run the DB suites with no POOL_DB_URL set)"
