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
const { BUILD_INFO } = require('../common/build-info.js');

const HELP_BUILD = '# HELP pool_build_info commit this process was started from (1 = always)';

function buildMetrics(m) {
  return [
    HELP_BUILD,
    '# TYPE pool_build_info gauge',
    `pool_build_info{commit="${BUILD_INFO.commit || 'unknown'}",started_at="${BUILD_INFO.startedAt}"} 1`,
    `pool_wallet_ticks_total ${m.ticks || 0}`,
    `pool_wallet_receipts_recorded_total ${m.receipts_recorded || 0}`,
    `pool_wallet_receipts_confirmed_total ${m.receipts_confirmed || 0}`,
    `pool_wallet_receipts_voided_total ${m.receipts_voided || 0}`,
    `pool_wallet_rpc_errors_total ${m.rpc_errors || 0}`,
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

  const metrics = { ticks: 0, receipts_recorded: 0, receipts_confirmed: 0, receipts_voided: 0, rpc_errors: 0 };
  const reconciler = createReconciler({
    db, rpcClient,
    confirmations: parseInt(process.env.POOL_WALLET_CONFIRMATIONS || '20', 10),
    logger: console,
  });

  const port = parseInt(process.env.POOL_WALLET_METRICS_PORT || '9102', 10);
  const server = require('node:http').createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, build: BUILD_INFO, signing: false, ...metrics }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(buildMetrics(metrics));
      return;
    }
    res.writeHead(404); res.end();
  }).listen(port, '127.0.0.1', () => console.log(`[WALLET] metrics on http://127.0.0.1:${port}/metrics`));

  console.log(`[WALLET] started commit=${BUILD_INFO.commitShort} node=${nodeUrl} signing=disabled`);

  const intervalMs = parseInt(process.env.POOL_WALLET_TICK_MS || '300000', 10);
  const timer = setInterval(async () => {
    try { await reconciler.tick(); metrics.ticks++; }
    catch (e) { metrics.rpc_errors++; console.log('WALLET', `tick failed: ${e.message}`); }
  }, intervalMs);

  const shutdown = async () => {
    clearInterval(timer);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await reconciler.tick().catch(e => console.log('WALLET', `initial tick failed: ${e.message}`));
  metrics.ticks++;
}

if (require.main === module) main().catch(e => { console.error('[WALLET] fatal:', e); process.exit(1); });

module.exports = { buildMetrics, HELP_BUILD };
