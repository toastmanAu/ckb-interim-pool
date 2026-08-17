#!/usr/bin/env node
'use strict';
/**
 * main.js — pool-wallet service.
 *
 * Reconciles treasury income on every deployment. Payout capability exists
 * only when a validated key is configured, and broadcast remains gated by
 * POOL_WALLET_ARMED=1 (with dry-run always overriding it).
 *
 *   POOL_DB_URL=... POOL_NODE_RPC=http://127.0.0.1:8114 node src/wallet/main.js
 */

const { createDb } = require('../accounting/db.js');
const { createRpcClient } = require('../edge/rpc.js');
const { createReconciler } = require('./reconciler.js');
const { snapshotTreasuryLocks } = require('./treasury.js');
const { loadKeystore } = require('./keystore.js');
const { createCkbInProcessBuilder } = require('./tx-builder-inprocess.js');
const { createPayoutWorker } = require('./payout-worker.js');
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

/** Only the exact opt-in value arms broadcast; dry-run always wins. */
function isArmed(env) {
  if (env.POOL_WALLET_DRY_RUN === '1') return false;
  return env.POOL_WALLET_ARMED === '1';
}

/** Validate key identity and assemble the payout runtime without starting I/O. */
function configurePayout({
  env,
  db,
  nodeUrl,
  logger = console,
  loadKeystoreFn = loadKeystore,
  createBuilderFn = createCkbInProcessBuilder,
  createWorkerFn = createPayoutWorker,
}) {
  const requestedArmed = isArmed(env);
  const keyPath = env.POOL_WALLET_KEY;
  if (!keyPath) {
    if (requestedArmed) {
      logger.log('WALLET', 'POOL_WALLET_ARMED=1 ignored: no POOL_WALLET_KEY configured');
    }
    return { keystore: null, payoutWorker: null, armed: false };
  }

  const keystore = loadKeystoreFn({
    keyPath,
    expectedAddress: env.POOL_WALLET_EXPECTED_ADDRESS || null,
    network: env.POOL_WALLET_NETWORK || 'ckb',
  });
  const txBuilder = createBuilderFn({
    rpcUrl: nodeUrl,
    indexerUrl: env.POOL_INDEXER_URL || null,
    privateKey: keystore.privateKey,
    feeRateShannons: parseInt(env.POOL_WALLET_FEE_RATE_SHANNONS || '1000', 10),
    logger,
  });
  const payoutWorker = createWorkerFn({
    db,
    txBuilder,
    minimumPayoutShannons: env.POOL_MIN_PAYOUT_SHANNONS || '100000000000',
    limits: {
      maxBatchShannons: env.POOL_WALLET_MAX_BATCH_SHANNONS || '200000000000',
      maxDailyShannons: env.POOL_WALLET_MAX_DAILY_SHANNONS || '1000000000000',
    },
    logger,
  });
  logger.log('WALLET', `signing key loaded for ${keystore.address}; armed=${requestedArmed}`);
  return { keystore, payoutWorker, armed: requestedArmed };
}

/**
 * Run payout work behind one testable safety boundary. Unarmed wallets may
 * construct/reserve a database batch but never call the broadcast state
 * machine. Payout failures have their own counter and never abort the other
 * wallet passes.
 */
async function runPayoutPass({ payoutWorker, armed, metrics, logger = console }) {
  if (!payoutWorker) return null;
  try {
    if (armed) return await payoutWorker.runOnce();
    const miners = await payoutWorker.eligibleMiners();
    if (miners.length === 0) return null;
    return await payoutWorker.createBatch(miners);
  } catch (error) {
    metrics.payout_errors = (metrics.payout_errors || 0) + 1;
    logger.log('PAYOUT', `tick failed: ${error.message}`);
    return null;
  }
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
    `pool_wallet_payout_errors_total ${m.payout_errors || 0}`,
    `pool_wallet_insolvency_total ${m.insolvency || 0}`,
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

  const metrics = {
    ticks: 0,
    rpc_errors: 0,
    snapshot_errors: 0,
    payout_errors: 0,
    insolvency: 0,
  };
  const reconciler = createReconciler({
    db, rpcClient,
    confirmations: parseInt(process.env.POOL_WALLET_CONFIRMATIONS || '20', 10),
    logger: console,
  });

  const { keystore, payoutWorker, armed } = configurePayout({
    env: process.env,
    db,
    nodeUrl,
    logger: console,
  });

  const port = parseInt(process.env.POOL_WALLET_METRICS_PORT || '9102', 10);
  const server = require('node:http').createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        build: BUILD_INFO,
        signing: Boolean(keystore),
        armed: Boolean(keystore && armed),
        ...metrics,
      }));
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

  console.log(
    `[WALLET] started commit=${BUILD_INFO.commitShort} node=${nodeUrl} ` +
    `signing=${keystore ? 'enabled' : 'disabled'} armed=${Boolean(keystore && armed)}`);

  const runServiceTick = async () => {
    try { await reconciler.tick(); metrics.ticks++; }
    catch (e) { metrics.rpc_errors++; console.log('WALLET', `tick failed: ${e.message}`); }

    await runPayoutPass({ payoutWorker, armed, metrics, logger: console });
    if (payoutWorker) metrics.insolvency = payoutWorker.stats.insolvency;

    try { await snapshotTreasuryLocks(db); }
    catch (e) { metrics.snapshot_errors++; console.log('WALLET', `snapshot failed: ${e.message}`); }
  };

  const intervalMs = parseInt(process.env.POOL_WALLET_TICK_MS || '300000', 10);
  const timer = setInterval(runServiceTick, intervalMs);

  const shutdown = async () => {
    clearInterval(timer);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await runServiceTick();
}

if (require.main === module) main().catch(e => { console.error('[WALLET] fatal:', e); process.exit(1); });

module.exports = {
  buildMetrics,
  HELP_BUILD,
  readReceiptCounts,
  isArmed,
  configurePayout,
  runPayoutPass,
};
