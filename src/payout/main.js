#!/usr/bin/env node
'use strict';
/**
 * payout-main.js — payout worker entry point.
 *
 *   POOL_DB_URL=postgres://... POOL_PAYOUT_DRY_RUN=1 \
 *     POOL_PAYOUT_KEY=</path/to/privkey> POOL_NODE_RPC=http://127.0.0.1:8114 \
 *     node src/payout/main.js
 *
 * One sweep per invocation (cron/systemd timer); advisory lock prevents
 * concurrent workers. Payout keys live only on this host — never on edges.
 * POOL_PAYOUT_DRY_RUN=1 builds the batch + dry-run documents without
 * broadcasting anything.
 */

const { createDb } = require('../accounting/db.js');
const { createPayoutWorker } = require('./payout-worker.js');
const { createDryRunBuilder, createCkbCliBuilder } = require('./tx-builder.js');
const { createRpcClient } = require('../edge/rpc.js');

(async () => {
  const db = createDb(process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest');
  const dryRun = process.env.POOL_PAYOUT_DRY_RUN === '1';
  const minimum = process.env.POOL_MIN_PAYOUT_SHANNONS || '100000000000';
  const rpcClient = createRpcClient({
    host: (process.env.POOL_NODE_RPC || 'http://127.0.0.1:8114').replace(/^https?:\/\//, '').split(':')[0] || '127.0.0.1',
    port: parseInt((process.env.POOL_NODE_RPC || 'http://127.0.0.1:8114').split(':').pop() || '8114', 10),
  });

  let txBuilder;
  if (dryRun) {
    txBuilder = createDryRunBuilder({ payoutAddress: process.env.POOL_PAYOUT_FROM || 'dry-run' });
  } else {
    if (!process.env.POOL_PAYOUT_KEY) {
      console.error('[PAYOUT] POOL_PAYOUT_KEY required unless POOL_PAYOUT_DRY_RUN=1');
      process.exit(2);
    }
    txBuilder = createCkbCliBuilder({
      privateKeyPath: process.env.POOL_PAYOUT_KEY,
      rpcUrl: process.env.POOL_NODE_RPC,
      maxTxFeeShannons: process.env.POOL_MAX_TX_FEE_SHANNONS || null,
      logger: console,
    });
  }

  const worker = createPayoutWorker({
    db, txBuilder,
    minimumPayoutShannons: minimum,
    logger: console,
  });

  const batch = await worker.runOnce();
  if (batch) console.log(`[PAYOUT] batch ${batch.batchId} created with ${batch.items} items${dryRun ? ' (DRY RUN — nothing broadcast)' : ''}`);
  else console.log('[PAYOUT] no eligible miners');
  await db.close();
})().catch(e => { console.error('[PAYOUT] fatal:', e); process.exit(1); });
