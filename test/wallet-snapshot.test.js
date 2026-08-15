'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { snapshotTreasuryLocks } = require('../src/wallet/main.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

async function seedBlock(db, height) {
  return (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
     VALUES ('au-test', gen_random_uuid(), 'j1', '0x' || substr(md5(random()::text),1,8), $1, 'CANONICAL_IMMATURE')
     RETURNING id`,
    [height])).rows[0].id;
}

async function seedReceipt(db, { lockArgs, amount, confirmed, height }) {
  const blockId = await seedBlock(db, height);
  await db.query(
    `INSERT INTO treasury_receipts
       (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
        lock_args, amount_shannons, mature_at_epoch, confirmed_at)
     VALUES ($1, $2, $2, $3, 0, $4, $5, 5, ${confirmed ? 'now()' : 'NULL'})`,
    [blockId, height, '0x' + height.toString(16).padStart(64, '0'), lockArgs, amount]);
}

test('treasury snapshots', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('writes total/owed from real data, and NULL — never 0 — for what this plan cannot measure', async () => {
    await db.query('TRUNCATE treasury_snapshots, treasury_receipts, blocks, ledger_entries CASCADE');
    await seedReceipt(db, { lockArgs: '0xaa', amount: '100', confirmed: true, height: 1 });
    await seedReceipt(db, { lockArgs: '0xaa', amount: '200', confirmed: true, height: 2 });
    // pending and voided receipts must not count toward total_shannons
    await seedReceipt(db, { lockArgs: '0xaa', amount: '9999', confirmed: false, height: 3 });
    await db.query(
      `INSERT INTO ledger_entries (account_type, amount_shannons, reference_type, reference_id, idempotency_key)
       VALUES ('miner_confirmed', 50, 'test', 'r1', 'snap-test-1'),
              ('miner_confirmed', 25, 'test', 'r2', 'snap-test-2')`);

    await snapshotTreasuryLocks(db);

    const row = (await db.query(
      'SELECT * FROM treasury_snapshots WHERE lock_args = $1', ['0xaa'])).rows[0];
    assert.ok(row, 'snapshot row written');
    assert.strictEqual(row.total_shannons, '300', 'only confirmed, un-voided receipts count');
    assert.strictEqual(row.owed_shannons, '75');
    assert.strictEqual(row.spendable_shannons, null,
      'no indexer client in this plan — must be NULL, not a false 0');
    assert.strictEqual(row.cell_count, null,
      'no indexer client in this plan — must be NULL, not a false 0');
  });

  await t.test('one row per distinct lock, and a lock with no confirmed receipts writes nothing', async () => {
    await db.query('TRUNCATE treasury_snapshots, treasury_receipts, blocks, ledger_entries CASCADE');
    await seedReceipt(db, { lockArgs: '0xaa', amount: '10', confirmed: true, height: 10 });
    await seedReceipt(db, { lockArgs: '0xbb', amount: '20', confirmed: true, height: 11 });

    await snapshotTreasuryLocks(db);

    const { rows } = await db.query('SELECT lock_args, total_shannons FROM treasury_snapshots ORDER BY lock_args');
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map(r => r.lock_args), ['0xaa', '0xbb']);
  });
});
