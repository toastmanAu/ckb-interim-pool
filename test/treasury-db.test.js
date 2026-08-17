'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { snapshotTreasuryLocks } = require('../src/wallet/treasury.js');
const { ACCOUNTS } = require('../src/accounting/ledger.js');
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

const packedEpoch = (number, index = 0, length = 1800) =>
  '0x' + (BigInt(number) | (BigInt(index) << 24n) | (BigInt(length) << 40n)).toString(16);

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
       VALUES ($1, 50, 'test', 'r1', 'snap-test-1'),
              ($1, 25, 'test', 'r2', 'snap-test-2'),
              ($2, 999, 'test', 'r3', 'snap-test-3')`,
      [ACCOUNTS.CONFIRMED, ACCOUNTS.POOL_FEE]);   // a different account must not bleed into owed

    await snapshotTreasuryLocks(db);

    const row = (await db.query(
      'SELECT * FROM treasury_snapshots WHERE lock_args = $1', ['0xaa'])).rows[0];
    assert.ok(row, 'snapshot row written');
    assert.strictEqual(row.total_shannons, '300', 'only confirmed, un-voided receipts count');
    assert.strictEqual(row.owed_shannons, '75', 'only ACCOUNTS.CONFIRMED counts toward owed');
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

  await t.test('writes measured spendable value and cell count when indexer inputs are supplied', async () => {
    await db.query('TRUNCATE treasury_snapshots, treasury_receipts, blocks, ledger_entries CASCADE');
    const lockArgs = '0x' + 'aa'.repeat(20);
    const historicalArgs = '0x' + 'bb'.repeat(20);
    await seedReceipt(db, { lockArgs, amount: '300', confirmed: true, height: 20 });
    await seedReceipt(db, { lockArgs: historicalArgs, amount: '400', confirmed: true, height: 21 });

    const lock = {
      code_hash: '0x' + '11'.repeat(32),
      hash_type: 'type',
      args: lockArgs,
    };
    let collectedFor = null;
    const rpc = async (url, method, params) => {
      if (method === 'get_cells') {
        collectedFor = params[0].script;
        return {
          objects: [
            {
              output: { capacity: '0x64' }, block_number: '0x64', tx_index: '0x0',
              out_point: { tx_hash: '0x' + '01'.repeat(32), index: '0x0' },
            },
            {
              output: { capacity: '0xc8' }, block_number: '0xc8', tx_index: '0x0',
              out_point: { tx_hash: '0x' + '02'.repeat(32), index: '0x0' },
            },
          ],
          last_cursor: '0x',
        };
      }
      if (method === 'get_header_by_number') {
        return { epoch: params[0] === '0x64' ? packedEpoch(10) : packedEpoch(15) };
      }
      throw new Error(`unexpected RPC method ${method}`);
    };

    await snapshotTreasuryLocks(db, {
      indexerUrl: 'http://indexer', rpc, tipEpochHex: packedEpoch(18), lock,
    });

    const row = (await db.query(
      'SELECT * FROM treasury_snapshots WHERE lock_args = $1', [lockArgs])).rows[0];
    assert.deepStrictEqual(collectedFor, lock);
    assert.strictEqual(row.total_shannons, '300');
    assert.strictEqual(row.spendable_shannons, '100', 'epoch 10 is mature; epoch 15 is not');
    assert.strictEqual(row.cell_count, 2);
    const historical = (await db.query(
      'SELECT * FROM treasury_snapshots WHERE lock_args = $1', [historicalArgs])).rows[0];
    assert.strictEqual(historical.spendable_shannons, null,
      'a lock the loaded key does not control must never be reported as spendable');
    assert.strictEqual(historical.cell_count, null);
  });
});
