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

  await t.test('a voided receipt makes room for its replacement', async () => {
    // migration 005: voiding fires on any reorg at H+11 that changes the
    // cellbase tx hash — routine. With the unique keys at table level the
    // voided row blocked every replacement forever and the block could never
    // be allocated again. Partial (live-rows-only) keys keep the invariant
    // while letting a fresh receipt supersede the withdrawn one.
    await db.query('TRUNCATE treasury_receipts CASCADE');
    const blk = (await db.query(
      `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
       VALUES ('e', gen_random_uuid(), 'j', '0x1', 100, 'NODE_ACCEPTED') RETURNING id`)).rows[0].id;
    const ins = `INSERT INTO treasury_receipts
      (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
       lock_args, amount_shannons, mature_at_epoch)
      VALUES ($1, 100, 111, $2, 0, '0xaa', 1, 5) RETURNING id`;
    const tx = '0x' + '44'.repeat(32);
    const first = (await db.query(ins, [blk, tx])).rows[0].id;

    await assert.rejects(() => db.query(ins, [blk, '0x' + '55'.repeat(32)]),
      /duplicate key|unique/i, 'two LIVE receipts for one block are still rejected');

    await db.query(`UPDATE treasury_receipts SET voided_at = now() WHERE id = $1`, [first]);
    // same block AND the same cellbase output: a chain that reorged away and
    // back must be re-recordable, not stranded
    await db.query(ins, [blk, tx]);

    const rows = (await db.query(
      `SELECT voided_at FROM treasury_receipts WHERE block_id = $1`, [blk])).rows;
    assert.strictEqual(rows.length, 2, 'the voided row is kept as history');
    assert.strictEqual(rows.filter(r => r.voided_at === null).length, 1, 'exactly one live receipt');
  });

  await t.test('wallet_config holds exactly one row', async () => {
    await db.query('TRUNCATE wallet_config');
    await db.query(`INSERT INTO wallet_config (id, cold_address) VALUES (1, 'ckb1abc')`);
    await assert.rejects(
      () => db.query(`INSERT INTO wallet_config (id, cold_address) VALUES (2, 'ckb1def')`),
      /check|constraint/i);
  });

  await t.test('treasury_snapshots allows NULL spendable_shannons and cell_count', async () => {
    // migration 004: these two figures require enumerating the treasury
    // lock's cells through an indexer, which Plan 1 does not have. NULL means
    // not-yet-measured; a NOT NULL column would force a false 0 in its place.
    const { rows } = await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'treasury_snapshots'
          AND column_name IN ('spendable_shannons', 'cell_count')
        ORDER BY column_name`);
    const byName = Object.fromEntries(rows.map(r => [r.column_name, r.is_nullable]));
    assert.strictEqual(byName.cell_count, 'YES', 'cell_count must allow NULL');
    assert.strictEqual(byName.spendable_shannons, 'YES', 'spendable_shannons must allow NULL');

    await db.query('TRUNCATE treasury_snapshots');
    await db.query(
      `INSERT INTO treasury_snapshots (lock_args, total_shannons, spendable_shannons, cell_count, owed_shannons)
       VALUES ('0xaa', 100, NULL, NULL, 0)`);
    const row = (await db.query('SELECT * FROM treasury_snapshots')).rows[0];
    assert.strictEqual(row.spendable_shannons, null);
    assert.strictEqual(row.cell_count, null);
  });

  await t.test('payout_batches gained the approval columns', async () => {
    const { rows } = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'payout_batches'
          AND column_name IN ('released_by', 'released_at')
        ORDER BY column_name`);
    const byName = Object.fromEntries(rows.map(r => [r.column_name, r.data_type]));
    assert.strictEqual(byName.released_at, 'timestamp with time zone',
      'released_at must exist and be timestamptz');
    assert.strictEqual(byName.released_by, 'text',
      'released_by must exist and be text');
  });
});
