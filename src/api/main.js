#!/usr/bin/env node
'use strict';
/**
 * api-main.js — public API + dashboard entry point.
 *
 *   POOL_DB_URL=postgres://... POOL_API_PORT=8080 node src/api/main.js
 *
 * Read-only; never on the mining/accounting critical path.
 */

const { createDb } = require('../accounting/db.js');
const { createApiServer } = require('./api-server.js');

(async () => {
  const db = createDb(process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest');
  const port = parseInt(process.env.POOL_API_PORT || '8080', 10);
  const policy = {
    feeBps: parseInt(process.env.POOL_FEE_BPS || '100', 10),
    pplnsWindow: process.env.POOL_PPLNS_WINDOW || '2.0',
    minimumPayoutShannons: process.env.POOL_MIN_PAYOUT_SHANNONS || '100000000000',
  };
  const api = createApiServer({ db, policy, logger: console });
  api.server.listen(port, '0.0.0.0', () => {
    console.log(`[API] public API + dashboard on :${port} (fee=${policy.feeBps}bps window=${policy.pplnsWindow})`);
  });
})().catch(e => { console.error('[API] fatal:', e); process.exit(1); });
