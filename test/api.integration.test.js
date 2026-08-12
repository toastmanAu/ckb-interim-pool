'use strict';
/**
 * api.integration.test.js — public API (read-only) against PostgreSQL.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const { createDb } = require('../src/accounting/db.js');
const { createApiServer } = require('../src/api/api-server.js');
const { postEntry, ACCOUNTS } = require('../src/accounting/ledger.js');
const { uuidv7 } = require('../src/common/ids.js');

const DB_URL = process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest';
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try {
  execSync(`docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1`);
  dbReady = true;
} catch { dbReady = false; }

const ADDR = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const EDGE = 'test-edge-01';
const BOOT = 'aabbccdd00112233445566778899eef0';

test('public API: pool, miner, policy endpoints', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE share_events, blocks, miners, workers, sessions, ledger_entries, ingested_events, edges, edge_boots, payout_batches, payout_items CASCADE');

  // seed: one miner, one worker, 3 shares, some confirmed balance, one block
  const m = (await db.query(`INSERT INTO miners (payout_address, network) VALUES ($1,'ckb') RETURNING id`, [ADDR])).rows[0];
  const w = (await db.query(`INSERT INTO workers (miner_id, worker_name) VALUES ($1,'k7-01') RETURNING id`, [m.id])).rows[0];
  await db.query(`INSERT INTO edges (id, region, status) VALUES ($1,'test','active')`, [EDGE]);
  for (let i = 1; i <= 3; i++) {
    await db.query(
      `INSERT INTO share_events (id, edge_id, boot_id, edge_seq, session_id, miner_id, worker_id,
         job_id, template_work_id, work_units, assigned_target, pow_hash, nonce, hash, accepted_at, is_block_candidate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0x1','4294967296','q','${'ab'.repeat(32)}',$9,'${'0x' + 'ef'.repeat(32)}',
               now() - make_interval(secs => $10), false)`,
      [uuidv7(), EDGE, BOOT, i, uuidv7(), m.id, w.id, `j${i}`, `0x${i.toString(16).padStart(32, '0')}`, i * 600],
    );
  }
  await postEntry(db, {
    accountType: ACCOUNTS.CONFIRMED, minerId: m.id, amountShannons: '123456789012',
    referenceType: 'test', referenceId: 'api', idempotencyKey: 'api:seed',
  });
  await db.query(
    `INSERT INTO blocks (id, edge_id, boot_id, job_id, nonce, height, state, reward_shannons, found_at)
     VALUES ($1,$2,$3,'j3','${'0x' + 'aa'.repeat(16)}',100,'MATURE','110000000000', now())`,
    [uuidv7(), EDGE, BOOT],
  );

  const api = createApiServer({ db, policy: { feeBps: 100, pplnsWindow: '2.0', minimumPayoutShannons: '100000000000' }, logger: { log: () => {} } });
  const server = api.server.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (p) => fetch(base + p).then(r => r.json());

  const pool = await get('/api/v1/pool');
  assert.strictEqual(pool.status, 'ok');
  assert.strictEqual(pool.fee_bps, 100);
  assert.strictEqual(pool.active_miners, 1);
  assert.strictEqual(pool.last_block.state, 'MATURE');
  assert.ok(pool.hashrate_1h !== '0', 'hashrate from work units');

  const miner = await get(`/api/v1/miners/${ADDR}`);
  assert.strictEqual(miner.balances.confirmed, '123456789012');
  assert.strictEqual(miner.stats.shares, 3);
  assert.strictEqual(miner.workers.length, 1);
  assert.ok(!('sessions' in miner), 'no internal session data exposed');
  assert.strictEqual((await get(`/api/v1/miners/${ADDR}/workers`)).length, 1);
  assert.strictEqual((await get(`/api/v1/miners/${ADDR}/shares?window=1h`)).length, 3);
  assert.strictEqual((await get(`/api/v1/miners/${'ckb1qyqinvalid'}`)).error, 'unknown miner');
  assert.strictEqual((await get('/api/v1/policy')).fee_bps, 100);
  assert.strictEqual((await get('/api/v1/edges'))[0].id, EDGE);
  assert.strictEqual((await get('/api/v1/blocks')).blocks.length, 1);
  assert.strictEqual((await get('/health')).ok, true);
  assert.strictEqual((await get('/nope')).error, 'not found');
});
