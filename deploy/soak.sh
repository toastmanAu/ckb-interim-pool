#!/usr/bin/env bash
# soak.sh — long-duration synthetic soak (spec 07 §10).
#
# Runs the rehearsal stack (edge on the live node + miner-sim) for N hours,
# sampling /health + DB growth every 60s, alerting on any degradation, and
# printing a summary. Intended to overlap the daily K7 window or run with
# the simulator 24/7.
#
# Usage: deploy/soak.sh <hours> [out-dir]    (default 24h, ./soak-out)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
HOURS="${1:-24}"
OUT="${2:-soak-out}"
mkdir -p "$OUT"
POOL_DB_URL="${POOL_DB_URL:-postgres://pool:pooltest@127.0.0.1:5433/pooltest}"
ADDR="${SOAK_ADDR:-ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v}"

echo "soak ${HOURS}h starting $(date -u) — logs in $OUT" | tee "$OUT/summary.txt"

# stack (reuses rehearsal topology; fresh stream each soak)
STREAM="POOL_V1_SOAK"
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
cat > /tmp/opencode/soak-edge.json <<EOF
{
  "edge": { "id": "soak-edge-01", "region": "soak", "stratumHost": "127.0.0.1",
            "stratumPort": 3339, "statsHost": "127.0.0.1", "statsPort": 8089, "network": "ckb" },
  "node": { "host": "192.168.68.105", "port": 8114, "wsPort": 28114, "pollMs": 250, "timeoutMs": 8000 },
  "vardiff": { "targetShareSec": 5, "retargetSec": 20, "variancePercent": 50,
               "minDiff": 0.000001, "maxDiff": 1000000, "initialDiff": 0.000001, "godminerInitialDiff": 0.000001 },
  "limits": { "maxConnectionsPerIp": 8, "maxConnectionsTotal": 64 },
  "spool": { "dir": "/tmp/opencode/soak-spool", "maxBytes": 1073741824, "syncIntervalMs": 1000 },
  "events": { "bus": "nats", "subjectPrefix": "pool.v1.edge",
              "nats": { "servers": ["$POOL_NATS_URL"], "stream": "$STREAM", "subjects": ["pool.v1.edge.>"] },
              "ackTimeoutMs": 10000, "reconnectSec": 2 }
}
EOF
POOL_CONFIG=/tmp/opencode/soak-edge.json node src/edge/main.js > "$OUT/edge.log" 2>&1 & E=$!
POOL_DB_URL="$POOL_DB_URL" POOL_NATS_URL="$POOL_NATS_URL" POOL_STREAM="$STREAM" \
  POOL_NODE_RPC=http://192.168.68.105:8114 \
  node src/accounting/main.js > "$OUT/ingest.log" 2>&1 & I=$!
trap 'kill $E $I $SIM 2>/dev/null; echo "soak stopped $(date -u)" >> "$OUT/summary.txt"' EXIT
sleep 4

# continuous simulator mining
node test/tools/miner-sim.js "127.0.0.1:3339" "$ADDR.soak-01" > "$OUT/sim.log" 2>&1 &
SIM=$!

END=$(( $(date +%s) + HOURS * 3600 ))
FAILURES=0
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 60
  TS=$(date -u +%H:%M:%S)
  H=$(curl -s --max-time 3 http://127.0.0.1:8089/health)
  OK=$(echo "$H" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const h=JSON.parse(d);process.stdout.write(String(h.ok&&h.node_healthy))}catch{process.stdout.write("bad")}})')
  SHARES=$(node -e "
    const { Pool } = require('pg');
    (async () => { const p = new Pool({ connectionString: '$POOL_DB_URL' });
      const r = (await p.query('SELECT count(*)::int c, COALESCE(sum(work_units),0)::text w FROM share_events')).rows[0];
      console.log(r.c + ' shares ' + r.w); await p.end(); })();
  " 2>/dev/null || echo "db-error")
  echo "$TS edge=$OK db=$SHARES"
  echo "$TS edge=$OK db=$SHARES" >> "$OUT/samples.txt"
  if [ "$OK" != "true" ]; then
    FAILURES=$((FAILURES + 1))
    echo "$TS DEGRADED — edge health: $H" >> "$OUT/summary.txt"
  fi
  if [ $(( $(date +%s) % 3600 )) -lt 60 ] && [ -f "$OUT/samples.txt" ]; then
    grep -c "edge=true" "$OUT/samples.txt" >> "$OUT/summary.txt"
  fi
done

echo "── soak summary ─────────────────────────────" | tee -a "$OUT/summary.txt"
tail -5 "$OUT/samples.txt"
grep -c "edge=true" "$OUT/samples.txt" | xargs -I{} echo "healthy samples: {}"
grep -c "edge=false" "$OUT/samples.txt" | xargs -I{} echo "unhealthy samples: {}"
echo "degradation events: $FAILURES" | tee -a "$OUT/summary.txt"
[ "$FAILURES" -eq 0 ] && echo "SOAK PASS" | tee -a "$OUT/summary.txt" || echo "SOAK FAIL" | tee -a "$OUT/summary.txt"
exit $([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)
