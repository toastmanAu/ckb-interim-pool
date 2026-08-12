'use strict';
/**
 * admin.integration.test.js — private operator console: token auth +
 * poolctl-backed endpoints against PostgreSQL.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const { createDb } = require('../src/accounting/db.js');
const { createAdminServer } = require('../src/api/admin-server.js');
const { postEntry, ACCOUNTS } = require('../src/accounting/ledger.js');
const { uuidv7 } = require('../src/common/ids.js');

const DB_URL = process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest';
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try {
  execSync(`docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1`);
  dbReady = true;
} catch { dbReady = false; }

const TOKEN = 'opensecret';
const ADDR = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';

test('admin console: auth + read/audit endpoints', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE ledger_entries, blocks, miners, ingested_events, edges CASCADE');

  await db.query(`INSERT INTO edges (id, region, status) VALUES ('admin-edge','test','active')`);
  await db.query(`INSERT INTO ingested_events (event_id, schema, edge_id, boot_id, edge_seq, payload_hash)
                  VALUES ('${'0'.repeat(32)}','pool.share.accepted.v1','admin-edge','${'1'.repeat(32)}',1,'abc')`);
  const m = (await db.query(`INSERT INTO miners (payout_address, network) VALUES ($1,'ckb') RETURNING id`, [ADDR])).rows[0];
  await postEntry(db, {
    accountType: ACCOUNTS.CONFIRMED, minerId: m.id, amountShannons: '77777777777',
    referenceType: 'test', referenceId: 'admin', idempotencyKey: 'admin:seed',
  });

  const admin = createAdminServer({ db, token: TOKEN });
  const server = admin.server.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p).then(r => r.json());

  // ── auth ──────────────────────────────────────────────────────────────────
  assert.strictEqual((await get('/admin/blocks')).error, 'unauthorized');
  assert.strictEqual((await get('/admin/blocks?token=wrong')).error, 'unauthorized');
  const blocks = await get('/admin/blocks?token=' + TOKEN);
  assert.ok(Array.isArray(blocks), 'authed read works');
  assert.strictEqual((await fetch(base + '/')).status, 401, 'page requires token');

  // ── endpoints ──────────────────────────────────────────────────────────────
  assert.strictEqual((await get(`/admin/miner?address=${ADDR}&token=${TOKEN}`)).confirmed, '77777777777');
  const ledger = await get('/admin/ledger/verify?token=' + TOKEN);
  assert.strictEqual(ledger.conserved, true);
  assert.strictEqual(ledger.duplicate_idempotency_keys, 0);
  const events = await get('/admin/events?token=' + TOKEN);
  assert.strictEqual(events[0].edge_id, 'admin-edge');
  assert.strictEqual((await get('/admin/payout?batch=nope&token=' + TOKEN)).batch.length, 0);
  assert.strictEqual((await get(`/admin/blocks/recompute?hash=0x0&token=${TOKEN}`)).error, 'block not found');
  assert.strictEqual((await get('/admin/nope?token=' + TOKEN)).error, 'not found');
});
