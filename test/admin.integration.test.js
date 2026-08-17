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

const { destructiveDbUrl } = require('./tools/test-db.js');
const DB_URL = destructiveDbUrl();   // refuses to point at the live database
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

  const admin = createAdminServer({ db, token: TOKEN, operator: 'test-operator' });
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
  const dashboard = await (await fetch(base + '/?token=' + TOKEN)).text();
  assert.match(dashboard, /id="treasury-title"/);
  assert.match(dashboard, /id="held"/);
  assert.match(dashboard, /Release held batch/);

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

  // ── treasury + audited release ───────────────────────────────────────────
  await t.test('treasury requires auth and reports every wallet work set', async () => {
    assert.strictEqual((await fetch(base + '/admin/treasury')).status, 401);
    await db.query(
      `TRUNCATE wallet_sweeps, treasury_snapshots, treasury_receipts,
                payout_items, payout_batches CASCADE`,
    );
    const blockId = (await db.query(
      `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, block_hash, state)
       VALUES ('admin-edge', gen_random_uuid(), 'treasury', '0x1', 100, $1, 'ALLOCATED')
       RETURNING id`, ['0x' + '22'.repeat(32)],
    )).rows[0].id;
    await db.query(
      `INSERT INTO treasury_receipts
         (block_id, block_height, payout_block_height, payout_tx_hash,
          output_index, lock_args, amount_shannons, mature_at_epoch, confirmed_at)
       VALUES ($1, 100, 111, $2, 0, '0xpool', 900, 10, now())`,
      [blockId, '0x' + '33'.repeat(32)],
    );
    await db.query(
      `INSERT INTO treasury_snapshots
         (lock_args, total_shannons, spendable_shannons, cell_count, owed_shannons)
       VALUES ('0xpool', 900, 800, 2, 300)`,
    );
    await db.query(
      `INSERT INTO payout_batches (id, state, held_reason)
       VALUES (gen_random_uuid(), 'HELD', 'per-batch cap exceeded'),
              (gen_random_uuid(), 'BROADCAST', NULL)`,
    );
    await db.query(
      `INSERT INTO wallet_sweeps
         (state, cold_address, amount_shannons, built_at, broadcast_at,
          confirmed_at, tx_hash, raw_tx_or_ref, fee_shannons)
       VALUES ('CONFIRMED', $1, 100, now(), now(), now(), $2, '{}', 2)`,
      [ADDR, '0x' + '44'.repeat(32)],
    );

    const response = await fetch(base + '/admin/treasury', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.snapshots[0].spendable_shannons, '800');
    assert.strictEqual(body.receipts[0].block_height, '100');
    assert.strictEqual(body.held.length, 1);
    assert.match(body.held[0].held_reason, /per-batch/i);
    assert.strictEqual(body.pending.length, 1);
    assert.strictEqual(body.sweeps.length, 1);
  });

  await t.test('release requires auth and cannot mutate a HELD batch without it', async () => {
    const id = (await db.query(
      `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'HELD') RETURNING id`,
    )).rows[0].id;
    const response = await fetch(base + '/admin/batches/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: id }),
    });
    assert.strictEqual(response.status, 401);
    assert.strictEqual((await db.query(
      `SELECT state FROM payout_batches WHERE id = $1`, [id],
    )).rows[0].state, 'HELD');
  });

  await t.test('authenticated release stamps the configured operator exactly once', async () => {
    const id = (await db.query(
      `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'HELD') RETURNING id`,
    )).rows[0].id;
    const response = await fetch(base + '/admin/batches/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ batchId: id }),
    });
    assert.strictEqual(response.status, 200);
    const row = (await db.query(
      `SELECT state, released_by, released_at FROM payout_batches WHERE id = $1`, [id],
    )).rows[0];
    assert.strictEqual(row.state, 'RESERVED');
    assert.strictEqual(row.released_by, 'test-operator');
    assert.ok(row.released_at);

    const repeated = await fetch(base + '/admin/batches/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ batchId: id }),
    });
    assert.strictEqual(repeated.status, 409);
  });

  await t.test('release refuses a batch that is not HELD', async () => {
    const id = (await db.query(
      `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'CONFIRMED') RETURNING id`,
    )).rows[0].id;
    const response = await fetch(base + '/admin/batches/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ batchId: id }),
    });
    assert.strictEqual(response.status, 409);
  });

  await t.test('release rejects malformed input without changing state', async () => {
    const id = (await db.query(
      `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'HELD') RETURNING id`,
    )).rows[0].id;
    const response = await fetch(base + '/admin/batches/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: '{not-json',
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await db.query(
      `SELECT state FROM payout_batches WHERE id = $1`, [id],
    )).rows[0].state, 'HELD');
  });

  await t.test('release rejects a malformed batch id as a client error', async () => {
    const response = await fetch(base + '/admin/batches/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ batchId: 'not-a-uuid' }),
    });
    assert.strictEqual(response.status, 400);
  });
});
