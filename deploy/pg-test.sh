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
for i in $(seq 1 20); do
  if docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1; then exit 0; fi
  sleep 0.5
done
echo "postgres not ready" >&2
exit 1
