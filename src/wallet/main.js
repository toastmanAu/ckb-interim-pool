#!/usr/bin/env node
'use strict';
/**
 * main.js — pool-wallet service.
 *
 * Plan 1 scope: reconcile income only. This process holds NO signing key and
 * has no transaction-building path; it cannot move funds. It reads Postgres and
 * the trusted CKB node, and listens on loopback for metrics only.
 *
 *   POOL_DB_URL=... POOL_NODE_RPC=http://127.0.0.1:8114 node src/wallet/main.js
 */

const { createDb } = require('../accounting/db.js');
const { createRpcClient } = require('../edge/rpc.js');
const { createReconciler } = require('./reconciler.js');
const { snapshotTreasuryLocks } = require('./treasury.js');
const { BUILD_INFO } = require('../common/build-info.js');

const HELP_BUILD = '# HELP pool_build_info commit this process was started from (1 = always)';

/**
 * Receipt state read from the database, not accumulated in process.
 * An in-process counter resets on restart and can drift from the table it
 * claims to describe; these figures are the table.
 */
async function readReceiptCounts(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE confirmed_at IS NOT NULL AND voided_at IS NULL)::int AS confirmed,
            count(*) FILTER (WHERE confirmed_at IS NULL     AND voided_at IS NULL)::int AS pending,
            count(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided
       FROM treasury_receipts`);
  return rows[0];
}

/**
 * @param {{ticks?: number, rpc_errors?: number, snapshot_errors?: number}} m  process-scoped counters
 * @param {{total?: number, confirmed?: number, pending?: number, voided?: number}} counts
 *   receipt gauges, freshly read from the database — these transition between
 *   states (pending -> confirmed | voided), so they are NOT `_total` counters.
 */
function buildMetrics(m, counts = {}) {
  return [
    HELP_BUILD,
    '# TYPE pool_build_info gauge',
    `pool_build_info{commit="${BUILD_INFO.commit || 'unknown'}",started_at="${BUILD_INFO.startedAt}"} 1`,
    `pool_wallet_ticks_total ${m.ticks || 0}`,
    `pool_wallet_rpc_errors_total ${m.rpc_errors || 0}`,
    // separate from rpc_errors: a snapshot-write failure is an observability
    // fault, not a reconciliation fault, and must not masquerade as one
    `pool_wallet_snapshot_errors_total ${m.snapshot_errors || 0}`,
    '# HELP pool_wallet_receipts_total treasury receipts recorded, any state (read from the database, not accumulated in process)',
    '# TYPE pool_wallet_receipts_total gauge',
    `pool_wallet_receipts_total ${counts.total || 0}`,
    '# HELP pool_wallet_receipts_confirmed treasury receipts confirmed (payout block reached confirmation depth with an unchanged cellbase)',
    '# TYPE pool_wallet_receipts_confirmed gauge',
    `pool_wallet_receipts_confirmed ${counts.confirmed || 0}`,
    '# HELP pool_wallet_receipts_pending treasury receipts recorded but not yet confirmed or voided',
    '# TYPE pool_wallet_receipts_pending gauge',
    `pool_wallet_receipts_pending ${counts.pending || 0}`,
    '# HELP pool_wallet_receipts_voided treasury receipts voided (payout block cellbase changed before confirmation)',
    '# TYPE pool_wallet_receipts_voided gauge',
    `pool_wallet_receipts_voided ${counts.voided || 0}`,
  ].join('\n') + '\n';
}

async function main() {
  const db = createDb(process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest');
  await db.migrate(require('node:path').join(__dirname, '..', '..', 'db', 'migrations'));

  const nodeUrl = process.env.POOL_NODE_RPC || 'http://127.0.0.1:8114';
  const rpcClient = createRpcClient({
    host: nodeUrl.replace(/^https?:\/\//, '').split(':')[0],
    port: parseInt(nodeUrl.split(':').pop() || '8114', 10),
  });

  const metrics = { ticks: 0, rpc_errors: 0, snapshot_errors: 0 };
  const reconciler = createReconciler({
    db, rpcClient,
    confirmations: parseInt(process.env.POOL_WALLET_CONFIRMATIONS || '20', 10),
    logger: console,
  });

  const port = parseInt(process.env.POOL_WALLET_METRICS_PORT || '9102', 10);
  const server = require('node:http').createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, build: BUILD_INFO, signing: false, ...metrics }));
      return;
    }
    if (req.url === '/metrics') {
      let counts;
      try {
        counts = await readReceiptCounts(db);
      } catch (e) {
        // a failed scrape is an honest signal; serving stale or zeroed
        // receipt gauges in its place would be the exact defect this fixes
        console.log('WALLET', `receipt count query failed: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('receipt count query failed\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(buildMetrics(metrics, counts));
      return;
    }
    res.writeHead(404); res.end();
  }).listen(port, '127.0.0.1', () => console.log(`[WALLET] metrics on http://127.0.0.1:${port}/metrics`));

  console.log(`[WALLET] started commit=${BUILD_INFO.commitShort} node=${nodeUrl} signing=disabled`);

  const intervalMs = parseInt(process.env.POOL_WALLET_TICK_MS || '300000', 10);
  const timer = setInterval(async () => {
    // two independent signals, deliberately not sharing a catch: a snapshot
    // write failing must never be indistinguishable from reconciliation
    // itself having broken (see pool_wallet_snapshot_errors_total above)
    try { await reconciler.tick(); metrics.ticks++; }
    catch (e) { metrics.rpc_errors++; console.log('WALLET', `tick failed: ${e.message}`); }

    try { await snapshotTreasuryLocks(db); }
    catch (e) { metrics.snapshot_errors++; console.log('WALLET', `snapshot failed: ${e.message}`); }
  }, intervalMs);

  const shutdown = async () => {
    clearInterval(timer);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try { await reconciler.tick(); metrics.ticks++; }
  catch (e) { metrics.rpc_errors++; console.log('WALLET', `initial tick failed: ${e.message}`); }

  try { await snapshotTreasuryLocks(db); }
  catch (e) { metrics.snapshot_errors++; console.log('WALLET', `initial snapshot failed: ${e.message}`); }
}

if (require.main === module) main().catch(e => { console.error('[WALLET] fatal:', e); process.exit(1); });

module.exports = { buildMetrics, HELP_BUILD, readReceiptCounts };
