#!/usr/bin/env bash
# Start a local NATS server for integration tests (JetStream enabled).
# Usage: deploy/nats-test.sh [port]   (default 4223)
set -euo pipefail
PORT="${1:-4223}"
if ! docker ps --format '{{.Names}}' | grep -q '^pool-nats-test$'; then
  docker rm -f pool-nats-test >/dev/null 2>&1 || true
  docker run -d --name pool-nats-test -p "${PORT}:4222" nats:2.10-alpine -js >/dev/null
  echo "nats test server on :${PORT}"
else
  docker start pool-nats-test >/dev/null
  echo "nats test server already running on :${PORT}"
fi
