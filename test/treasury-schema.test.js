'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

test('treasury schema', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('treasury_receipts exists with a unique block_id', async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'treasury_receipts' ORDER BY column_name`);
    const cols = rows.map(r => r.column_name);
    for (const c of ['block_id', 'block_height', 'payout_block_height', 'payout_tx_hash',
                     'output_index', 'lock_args', 'amount_shannons', 'mature_at_epoch',
                     'confirmed_at', 'voided_at']) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });

  await t.test('a block cannot have two receipts', async () => {
    await db.query('TRUNCATE treasury_receipts CASCADE');
    const blk = (await db.query(
      `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
       VALUES ('e', gen_random_uuid(), 'j', '0x1', 100, 'NODE_ACCEPTED') RETURNING id`)).rows[0].id;
    const ins = `INSERT INTO treasury_receipts
      (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
       lock_args, amount_shannons, mature_at_epoch)
      VALUES ($1, 100, 111, $2, 0, '0xaa', 1, 5)`;
    await db.query(ins, [blk, '0x' + '11'.repeat(32)]);
    await assert.rejects(
      () => db.query(ins, [blk, '0x' + '22'.repeat(32)]),
      /duplicate key|unique/i,
      'one block, one receipt — a second must be rejected by the database');
  });

  await t.test('the same output cannot be claimed twice', async () => {
    await db.query('TRUNCATE treasury_receipts CASCADE');
    const mk = async () => (await db.query(
      `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
       VALUES ('e', gen_random_uuid(), 'j', '0x' || substr(md5(random()::text),1,8), 100, 'NODE_ACCEPTED')
       RETURNING id`)).rows[0].id;
    const tx = '0x' + '33'.repeat(32);
    await db.query(`INSERT INTO treasury_receipts
      (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
       lock_args, amount_shannons, mature_at_epoch) VALUES ($1,100,111,$2,0,'0xaa',1,5)`,
      [await mk(), tx]);
    await assert.rejects(
      async () => db.query(`INSERT INTO treasury_receipts
        (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
         lock_args, amount_shannons, mature_at_epoch) VALUES ($1,100,111,$2,0,'0xaa',1,5)`,
        [await mk(), tx]),
      /duplicate key|unique/i,
      'two blocks must not both claim the same cellbase output');
  });

  await t.test('wallet_config holds exactly one row', async () => {
    await db.query('TRUNCATE wallet_config');
    await db.query(`INSERT INTO wallet_config (id, cold_address) VALUES (1, 'ckb1abc')`);
    await assert.rejects(
      () => db.query(`INSERT INTO wallet_config (id, cold_address) VALUES (2, 'ckb1def')`),
      /check|constraint/i);
  });
});
