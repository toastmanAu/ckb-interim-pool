#!/usr/bin/env bash
# drill-devchain.sh — full definition-of-done lifecycle on a local dev chain:
#
#   miner-sim → edge(dev node) → block found → NATS → ingest →
#   canonical → immature → mature(4 epochs) → PPLNS allocation → ledger →
#   real signed CKB payout transaction → node confirmation
#
# Requires the dev node: deploy/ckb-dev-test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
POOL_DB_URL="${POOL_DB_URL:-postgres://pool:pooltest@127.0.0.1:5433/pooltest}"
POOL_NATS_URL="${POOL_NATS_URL:-nats://127.0.0.1:4223}"
STREAM="POOL_V1_DEV"
DEV_RPC="${DEV_RPC:-http://127.0.0.1:8115}"
ADDR="ckt1qyqdcy57049wv82wjwca8a236c8hgxvp6n7s6gdcsj"   # pool key (dev chain)
MINING_SECS="${MINING_SECS:-90}"

deploy/nats-test.sh >/dev/null; deploy/pg-test.sh >/dev/null
node -e "
const { Pool } = require('pg');
(async () => { const p = new Pool({ connectionString: '$POOL_DB_URL' });
  await p.query('TRUNCATE ledger_entries, block_allocations, block_allocation_items, payout_batches, payout_items, share_events, blocks, ingested_events, sessions, workers, miners, edges, edge_boots, config_snapshots CASCADE'); await p.end(); })();
"
node -e "
const { connect } = require('nats');
(async () => { const nc = await connect({ servers: '$POOL_NATS_URL' });
  const jsm = await nc.jetstreamManager();
  const it = await jsm.streams.list();
  for await (const s of it) { try { await jsm.streams.delete(s.config.name); } catch {} }
  await nc.close(); })();
"

cat > /tmp/opencode/dev-edge.json <<EOF
{
  "edge": { "id": "dev-edge-01", "region": "dev", "stratumHost": "127.0.0.1",
            "stratumPort": 3338, "statsHost": "127.0.0.1", "statsPort": 8088, "network": "ckt" },
  "node": { "host": "127.0.0.1", "port": 8115, "wsPort": 28115, "pollMs": 250, "timeoutMs": 8000 },
  "vardiff": { "targetShareSec": 2, "retargetSec": 10, "variancePercent": 50,
               "minDiff": 0.000001, "maxDiff": 1000000, "initialDiff": 0.000001, "godminerInitialDiff": 0.000001 },
  "limits": { "maxConnectionsPerIp": 8, "maxConnectionsTotal": 64 },
  "spool": { "dir": "/tmp/opencode/dev-spool", "maxBytes": 1073741824, "syncIntervalMs": 500 },
  "events": { "bus": "nats", "subjectPrefix": "pool.v1.edge",
              "nats": { "servers": ["$POOL_NATS_URL"], "stream": "$STREAM", "subjects": ["pool.v1.edge.>"] },
              "ackTimeoutMs": 10000, "reconnectSec": 2 }
}
EOF

echo "── dev-chain drill ──────────────────────────────"
POOL_CONFIG=/tmp/opencode/dev-edge.json node src/edge/main.js > /tmp/opencode/dev-edge.log 2>&1 & E=$!
POOL_DB_URL="$POOL_DB_URL" POOL_NATS_URL="$POOL_NATS_URL" POOL_STREAM="$STREAM" \
  POOL_NODE_RPC="$DEV_RPC" POOL_BLOCK_INTERVAL_MS=2000 \
  node src/accounting/main.js > /tmp/opencode/dev-ingest.log 2>&1 & INGEST=$!
trap 'kill $E $INGEST 2>/dev/null' EXIT
sleep 4

echo "1) mining dev chain ${MINING_SECS}s (every share ≈ a block)…"
timeout "$MINING_SECS" node test/tools/miner-sim.js "127.0.0.1:3338" "$ADDR.dev-01" >/dev/null 2>&1 || true

echo "2) block lifecycle (canonical → mature → allocated)…"
sleep 15
node -e "
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: '$POOL_DB_URL' });
  const r = (await p.query(\`
    SELECT (SELECT count(*)::int FROM blocks) blocks,
           (SELECT count(*)::int FROM blocks WHERE state='MATURE') mature,
           (SELECT count(*)::int FROM blocks WHERE state='SETTLED_TO_LEDGER') settled,
           (SELECT count(*)::int FROM blocks WHERE state='ORPHANED') orphaned,
           (SELECT count(*)::int FROM share_events) shares,
           (SELECT count(*)::int FROM ledger_entries) ledger,
           (SELECT COALESCE(sum(credit_shannons),0)::text FROM block_allocation_items) credited,
           (SELECT COALESCE(sum(amount_shannons),0)::text FROM ledger_entries WHERE account_type='miner_confirmed') confirmed\`)).rows[0];
  console.log(JSON.stringify(r));
  await p.end();
})();
"

echo "3) payout dry-run + real signed transaction…"
POOL_DB_URL="$POOL_DB_URL" POOL_PAYOUT_DRY_RUN=1 node src/payout/main.js 2>&1 | tail -1
node -e "
const { buildAndSendPayout } = require('./src/payout/ckb-tx-builder.js');
const key = require('/tmp/opencode/pool-key.json');
(async () => {
  const r = await buildAndSendPayout({
    rpcUrl: '$DEV_RPC',
    privateKey: Buffer.from(key.priv, 'hex'),
    toAddresses: [{ address: '$ADDR', capacityShannons: null }],   // null = sweep remainder minus fee
    feeRateShannons: 1000,
  });
  console.log(JSON.stringify(r, null, 2));
})();
"
