#!/usr/bin/env bash
# stack-rehearsal.sh — full-stack rehearsal against the live node:
#
#   postgres ── nats ── edge(.105) ── miner-sim
#       ▲          │
#       └── ingest ┘── api/dashboard
#
# Proves the whole chain with REAL shares hashed by the simulator against
# the live mainnet template, then shows the dashboard reflecting them.
#
# Usage: deploy/stack-rehearsal.sh [duration-sec]   (default 45s)
set -uo pipefail

DURATION="${1:-45}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

POOL_DB_URL="${POOL_DB_URL:-postgres://pool:pooltest@127.0.0.1:5433/pooltest}"
POOL_NATS_URL="${POOL_NATS_URL:-nats://127.0.0.1:4223}"
STREAM="POOL_V1_REHEARSAL"
ADDR="${REHEARSAL_ADDR:-ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v}"

echo "── stack rehearsal (${DURATION}s) ──────────────────────────────"
deploy/nats-test.sh >/dev/null
deploy/pg-test.sh >/dev/null

# clean DB + stream
node -e "
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: '$POOL_DB_URL' });
  await p.query('TRUNCATE share_events, blocks, ingested_events, sessions, workers, miners, edges, edge_boots CASCADE');
  await p.end();
})();
"
node -e "
const { connect } = require('nats');
(async () => {
  const nc = await connect({ servers: '$POOL_NATS_URL' });
  const jsm = await nc.jetstreamManager();
  try { await jsm.streams.delete('$STREAM'); } catch {}
  await nc.close();
})();
"

# edge with nats bus (background) — starts BEFORE ingest so the stream exists
cat > /tmp/opencode/rehearsal-edge.json <<EOF
{
  "edge": { "id": "rehearsal-01", "region": "test", "stratumHost": "127.0.0.1",
            "stratumPort": 3334, "statsHost": "127.0.0.1", "statsPort": 8083, "network": "ckb" },
  "node": { "host": "192.168.68.105", "port": 8114, "wsPort": 28114, "pollMs": 250, "timeoutMs": 8000 },
  "vardiff": { "targetShareSec": 5, "retargetSec": 20, "variancePercent": 50,
               "minDiff": 0.000001, "maxDiff": 1000000, "initialDiff": 0.000001,
               "godminerInitialDiff": 0.000001 },
  "limits": { "maxConnectionsPerIp": 8, "maxConnectionsTotal": 64 },
  "spool": { "dir": "/tmp/opencode/rehearsal-spool", "maxBytes": 1073741824, "syncIntervalMs": 500 },
  "events": { "bus": "nats", "subjectPrefix": "pool.v1.rehearsal",
              "nats": { "servers": ["$POOL_NATS_URL"], "stream": "$STREAM", "subjects": ["pool.v1.rehearsal.>"] },
              "ackTimeoutMs": 10000, "reconnectSec": 2 }
}
EOF
POOL_CONFIG=/tmp/opencode/rehearsal-edge.json node src/edge/main.js > /tmp/opencode/rehearsal-edge.log 2>&1 &
EDGE_PID=$!
echo "edge pid $EDGE_PID (stratum :3334 stats :8083)"
sleep 3

# ingest consumer (background) — subjects must match the rehearsal stream
POOL_DB_URL="$POOL_DB_URL" POOL_NATS_URL="$POOL_NATS_URL" POOL_STREAM="$STREAM" \
  POOL_EVENT_SUBJECTS="pool.v1.rehearsal.>" \
  node src/accounting/main.js > /tmp/opencode/rehearsal-ingest.log 2>&1 &
INGEST_PID=$!
echo "ingest pid $INGEST_PID"

# api (background)
POOL_DB_URL="$POOL_DB_URL" POOL_API_PORT=8084 node src/api/main.js > /tmp/opencode/rehearsal-api.log 2>&1 &
API_PID=$!
echo "api pid $API_PID (:8084)"

cleanup() {
  kill "$EDGE_PID" "$INGEST_PID" "$API_PID" 2>/dev/null
  echo ""
  echo "── rehearsal done ──────────────────────────────"
}
trap cleanup INT TERM EXIT

sleep 4
echo "── mining with simulator for ${DURATION}s ──"
timeout "$DURATION" node test/tools/miner-sim.js "127.0.0.1:3334" "$ADDR.sim-01" || true

echo ""
echo "── results ───────────────────────────────────"
echo "edge health:    $(curl -s http://127.0.0.1:8083/health | head -c 120)"
echo "api pool:       $(curl -s http://127.0.0.1:8084/api/v1/pool | head -c 300)"
echo "api miner:      $(curl -s http://127.0.0.1:8084/api/v1/miners/$ADDR | head -c 400)"
echo "ingest db:      $(node -e 'const {Pool}=require("pg");(async()=>{const p=new Pool({connectionString:"$POOL_DB_URL"});const r=await p.query("SELECT (SELECT count(*) FROM share_events) s, (SELECT count(*) FROM ingested_events) i");console.log(r.rows[0].s+" shares, "+r.rows[0].i+" events ingested");await p.end()})()')"
echo "edge metrics:   $(curl -s http://127.0.0.1:8083/metrics | grep -E 'shares_(accepted|rejected)' | tr '\n' ' ')"
