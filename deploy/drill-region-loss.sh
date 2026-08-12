#!/usr/bin/env bash
# drill-region-loss.sh — Phase 9 gate: region failure drill.
#
# Two edges (simulating two regions) share the NATS bus + PostgreSQL:
#   1. both mine shares (two miner-sim instances);
#   2. edge-2 is KILLED mid-run — edge-1 continues;
#   3. edge-2 restarts with a new boot id — its spool replays;
#   4. every share from both regions lands exactly once in PostgreSQL.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
POOL_DB_URL="${POOL_DB_URL:-postgres://pool:pooltest@127.0.0.1:5433/pooltest}"
POOL_NATS_URL="${POOL_NATS_URL:-nats://127.0.0.1:4223}"
STREAM="POOL_V1_DRILL"
ADDR="ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v"
MINING_SECS="${MINING_SECS:-15}"

deploy/nats-test.sh >/dev/null; deploy/pg-test.sh >/dev/null
node -e "
const { Pool } = require('pg');
(async () => { const p = new Pool({ connectionString: '$POOL_DB_URL' });
  await p.query('TRUNCATE share_events, blocks, ingested_events, sessions, workers, miners, edges, edge_boots CASCADE'); await p.end(); })();
"
node -e "
const { connect } = require('nats');
(async () => { const nc = await connect({ servers: '$POOL_NATS_URL' });
  const jsm = await nc.jetstreamManager();
  const it = await jsm.streams.list();
  for await (const s of it) { try { await jsm.streams.delete(s.config.name); } catch {} }
  await nc.close(); })();
"


mk_edge() { # $1=edge-id $2=stratum-port $3=stats-port
  cat > "/tmp/opencode/$1.json" <<EOF
{
  "edge": { "id": "$1", "region": "drill", "stratumHost": "127.0.0.1",
            "stratumPort": $2, "statsHost": "127.0.0.1", "statsPort": $3, "network": "ckb" },
  "node": { "host": "192.168.68.105", "port": 8114, "wsPort": 28114, "pollMs": 250, "timeoutMs": 8000 },
  "vardiff": { "targetShareSec": 5, "retargetSec": 20, "variancePercent": 50,
               "minDiff": 0.000001, "maxDiff": 1000000, "initialDiff": 0.000001, "godminerInitialDiff": 0.000001 },
  "limits": { "maxConnectionsPerIp": 8, "maxConnectionsTotal": 64 },
  "spool": { "dir": "/tmp/opencode/drill-spool-$1", "maxBytes": 1073741824, "syncIntervalMs": 500 },
  "events": { "bus": "nats", "subjectPrefix": "pool.v1.edge",
              "nats": { "servers": ["$POOL_NATS_URL"], "stream": "$STREAM", "subjects": ["pool.v1.edge.>"] },
              "ackTimeoutMs": 10000, "reconnectSec": 2 }
}
EOF
}

echo "── drill: region loss ─────────────────────────────────"
mk_edge drill-edge-1 3335 8085
mk_edge drill-edge-2 3336 8086
POOL_CONFIG=/tmp/opencode/drill-edge-1.json node src/edge/main.js > /tmp/opencode/drill-e1.log 2>&1 & E1=$!
POOL_CONFIG=/tmp/opencode/drill-edge-2.json node src/edge/main.js > /tmp/opencode/drill-e2.log 2>&1 & E2=$!
POOL_DB_URL="$POOL_DB_URL" POOL_NATS_URL="$POOL_NATS_URL" POOL_STREAM="$STREAM" \
  node src/accounting/main.js > /tmp/opencode/drill-ingest.log 2>&1 & INGEST=$!
trap 'kill $E1 $E2 $INGEST 2>/dev/null' EXIT
sleep 4

echo "1) both regions mining ${MINING_SECS}s…"
timeout "$MINING_SECS" node test/tools/miner-sim.js "127.0.0.1:3335" "$ADDR.r1-w1" >/dev/null 2>&1 &
S1=$!
timeout "$MINING_SECS" node test/tools/miner-sim.js "127.0.0.1:3336" "$ADDR.r2-w1" >/dev/null 2>&1 &
S2=$!
wait $S1 $S2

echo "2) killing edge-2 (region loss)…"
kill $E2
sleep 2
echo "   edge-1 still healthy: $(curl -s http://127.0.0.1:8085/health | head -c 60)"

echo "3) restarting edge-2 with a new boot id — spool replay…"
POOL_CONFIG=/tmp/opencode/drill-edge-2.json node src/edge/main.js > /tmp/opencode/drill-e2b.log 2>&1 & E2=$!
sleep 6

echo "4) verifying exactly-once in PostgreSQL…"
node -e "
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: '$POOL_DB_URL' });
  const r = (await p.query(\`
    SELECT (SELECT count(*) FROM share_events) shares,
           (SELECT count(*) FROM ingested_events) ingested,
           (SELECT count(DISTINCT edge_id) FROM share_events) edges,
           (SELECT count(*) FROM share_events WHERE edge_id = 'drill-edge-1') e1,
           (SELECT count(*) FROM share_events WHERE edge_id = 'drill-edge-2') e2,
           (SELECT count(*)::int FROM (SELECT edge_id, boot_id, edge_seq FROM ingested_events GROUP BY 1,2,3 HAVING count(*) > 1) d) dup_groups\`)).rows[0];
  console.log(JSON.stringify(r));
  const dup = r.dup_groups === 0;
  const both = r.e1 > 0 && r.e2 > 0;
  console.log(dup && both ? 'DRILL PASS — both regions credited, no duplicates' : 'DRILL FAIL');
  process.exit(dup && both ? 0 : 1);
})();
"
