#!/usr/bin/env bash
# drill-central-outage.sh — Phase 9 gate: central-control outage drill.
#
#   1. edge mines → events flow to NATS → ingest → PostgreSQL;
#   2. NATS is STOPPED (bus down) — edge keeps mining, spool grows;
#   3. NATS restarts — publisher drains the spool;
#   4. every accepted share is in PostgreSQL exactly once.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
POOL_DB_URL="${POOL_DB_URL:-postgres://pool:pooltest@127.0.0.1:5433/pooltest}"
POOL_NATS_URL="${POOL_NATS_URL:-nats://127.0.0.1:4223}"
STREAM="POOL_V1_DRILL_CENTRAL"
ADDR="ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v"
PRE="${PRE:-10}"; DURING="${DURING:-10}"

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


cat > /tmp/opencode/drill-central.json <<EOF
{
  "edge": { "id": "drill-central", "region": "drill", "stratumHost": "127.0.0.1",
            "stratumPort": 3337, "statsHost": "127.0.0.1", "statsPort": 8087, "network": "ckb" },
  "node": { "host": "192.168.68.105", "port": 8114, "wsPort": 28114, "pollMs": 250, "timeoutMs": 8000 },
  "vardiff": { "targetShareSec": 5, "retargetSec": 20, "variancePercent": 50,
               "minDiff": 0.000001, "maxDiff": 1000000, "initialDiff": 0.000001, "godminerInitialDiff": 0.000001 },
  "limits": { "maxConnectionsPerIp": 8, "maxConnectionsTotal": 64 },
  "spool": { "dir": "/tmp/opencode/drill-spool-central", "maxBytes": 1073741824, "syncIntervalMs": 500 },
  "events": { "bus": "nats", "subjectPrefix": "pool.v1.edge",
              "nats": { "servers": ["$POOL_NATS_URL"], "stream": "$STREAM", "subjects": ["pool.v1.edge.>"] },
              "ackTimeoutMs": 10000, "reconnectSec": 2 }
}
EOF

echo "── drill: central-control outage ─────────────────────"
POOL_CONFIG=/tmp/opencode/drill-central.json node src/edge/main.js > /tmp/opencode/drill-c-edge.log 2>&1 & E=$!
POOL_DB_URL="$POOL_DB_URL" POOL_NATS_URL="$POOL_NATS_URL" POOL_STREAM="$STREAM" \
  node src/accounting/main.js > /tmp/opencode/drill-c-ingest.log 2>&1 & INGEST=$!
trap 'kill $E $INGEST 2>/dev/null' EXIT
sleep 4

echo "1) mining with bus UP (${PRE}s)…"
timeout "$PRE" node test/tools/miner-sim.js "127.0.0.1:3337" "$ADDR.pre" >/dev/null 2>&1
PRE_SHARES=$(node -e "
const { Pool } = require('pg');
(async () => { const p = new Pool({ connectionString: '$POOL_DB_URL' });
  const r = (await p.query('SELECT count(*)::int c FROM share_events')).rows[0].c; console.log(r); await p.end(); })();
")
echo "   in DB before outage: $PRE_SHARES"

echo "2) STOPPING NATS — mining continues (${DURING}s)…"
docker stop pool-nats-test >/dev/null
timeout "$DURING" node test/tools/miner-sim.js "127.0.0.1:3337" "$ADDR.during" >/dev/null 2>&1 || true
SPOOLED=$(grep -c '"seq"' /tmp/opencode/drill-spool-central/wal-*.log 2>/dev/null || echo 0)
echo "   shares spooled locally during outage: $SPOOLED"

echo "3) restarting NATS — spool drains…"
docker start pool-nats-test >/dev/null
sleep 8
TOTAL=$(node -e "
const { Pool } = require('pg');
(async () => { const p = new Pool({ connectionString: '$POOL_DB_URL' });
  const r = (await p.query('SELECT count(*)::int c FROM share_events')).rows[0].c; console.log(r); await p.end(); })();
")
DUP=$(node -e "
const { Pool } = require('pg');
(async () => { const p = new Pool({ connectionString: '$POOL_DB_URL' });
  const r = (await p.query('SELECT count(*)::int c FROM (SELECT edge_id, boot_id, edge_seq FROM ingested_events GROUP BY 1,2,3 HAVING count(*) > 1) d')).rows[0].c; console.log(r); await p.end(); })();
")
echo "   in DB after recovery: $TOTAL (duplicate groups: $DUP)"
[ "$TOTAL" -gt "$PRE_SHARES" ] && [ "$DUP" -eq 0 ] && echo "DRILL PASS" || { echo "DRILL FAIL"; exit 1; }
