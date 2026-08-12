#!/usr/bin/env node
'use strict';
/**
 * admin-main.js — operator console entry point (localhost only).
 *
 *   POOL_DB_URL=postgres://… POOL_ADMIN_TOKEN=<secret> \
 *     POOL_ADMIN_PORT=8085 node src/api/admin-main.js
 */

const { createDb } = require('../accounting/db.js');
const { createAdminServer } = require('./admin-server.js');

(async () => {
  const db = createDb(process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest');
  const port = parseInt(process.env.POOL_ADMIN_PORT || '8085', 10);
  const token = process.env.POOL_ADMIN_TOKEN || '';
  if (!token) {
    console.error('[ADMIN] POOL_ADMIN_TOKEN is required — refusing to start without auth');
    process.exit(2);
  }
  const admin = createAdminServer({ db, token });
  admin.server.listen(port, '127.0.0.1', () => {
    console.log(`[ADMIN] operator console on http://127.0.0.1:${port}/?token=… (localhost only)`);
  });
})().catch(e => { console.error('[ADMIN] fatal:', e); process.exit(1); });
