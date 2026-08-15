'use strict';
/**
 * wallet-status.test.js — `poolctl wallet status` must not print an all-clear
 * over a stuck pool.
 *
 * The count it reports is an operator's only routine signal that
 * reconciliation is keeping up; a figure narrower than the reconciler's own
 * work set reads as 0 while a block is permanently stranded.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { walletStatus } = require('../src/accounting/poolctl.js');
const { ACCOUNTS } = require('../src/accounting/ledger.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

async function seedBlock(db, height, state) {
  return (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
     VALUES ('e', gen_random_uuid(), 'j', '0x1', $1, $2) RETURNING id`,
    [height, state])).rows[0].id;
}

async function seedReceipt(db, blockId, height, { confirmed = false, voided = false } = {}) {
  await db.query(
    `INSERT INTO treasury_receipts
       (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
        lock_args, amount_shannons, mature_at_epoch, confirmed_at, voided_at)
     VALUES ($1, $2, $3, $4, 0, '0xaa', 1000, 5,
             CASE WHEN $5 THEN now() END, CASE WHEN $6 THEN now() END)`,
    [blockId, height, height + 11,
     '0x' + height.toString(16).padStart(64, '0'), confirmed, voided]);
}

test('poolctl wallet status', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('awaiting count mirrors the reconciler\'s work set', async () => {
    await db.query('TRUNCATE treasury_receipts, ledger_entries, blocks CASCADE');

    // 1. immature, never reconciled — the reconciler scans it, so must we
    await seedBlock(db, 101, 'CANONICAL_IMMATURE');
    // 2. mature with a receipt that has NOT confirmed yet — still work
    const pending = await seedBlock(db, 102, 'MATURE');
    await seedReceipt(db, pending, 102);
    // 3. voided receipt and no replacement — the stranded case
    const voided = await seedBlock(db, 103, 'MATURE');
    await seedReceipt(db, voided, 103, { voided: true });
    // 4. done: confirmed, un-voided
    const done = await seedBlock(db, 104, 'SETTLED_TO_LEDGER');
    await seedReceipt(db, done, 104, { confirmed: true });
    // 5. orphaned blocks are outside the reconciler's scope entirely
    await seedBlock(db, 105, 'ORPHANED');

    const s = await walletStatus(db);
    assert.strictEqual(s.blocks_awaiting_reconciliation, 3,
      'immature + pending-receipt + voided-receipt blocks are all unreconciled work');
    assert.strictEqual(s.blocks_with_voided_receipts, 1,
      'a stranded block must be reported distinctly, not folded into the total');
  });

  await t.test('a confirmed receipt on every block reports zero outstanding', async () => {
    await db.query('TRUNCATE treasury_receipts, ledger_entries, blocks CASCADE');
    const id = await seedBlock(db, 201, 'MATURE');
    await seedReceipt(db, id, 201, { confirmed: true });
    const s = await walletStatus(db);
    assert.strictEqual(s.blocks_awaiting_reconciliation, 0);
    assert.strictEqual(s.blocks_with_voided_receipts, 0);
  });

  await t.test('liabilities include amounts already reserved for payout', async () => {
    await db.query('TRUNCATE treasury_receipts, ledger_entries, blocks CASCADE');
    const id = await seedBlock(db, 301, 'SETTLED_TO_LEDGER');
    await seedReceipt(db, id, 301, { confirmed: true });   // received = 1000

    const post = (accountType, amount, key) => db.query(
      `INSERT INTO ledger_entries (account_type, amount_shannons, reference_type, reference_id, idempotency_key)
       VALUES ($1, $2, 'block', $3, $4)`, [accountType, amount, String(id), key]);
    await post(ACCOUNTS.CONFIRMED, '600', 'k1');
    // the payout worker debits miner_confirmed into miner_pending_payout: the
    // pool still owes this, and counting only miner_confirmed would make the
    // comparison improve merely because a batch was created
    await post(ACCOUNTS.PENDING_PAYOUT, '600', 'k2');

    const s = await walletStatus(db);
    assert.strictEqual(s.owed_shannons, '1200', 'pending payouts are a real liability');
    assert.strictEqual(s.lifetime_income_covers_current_liabilities, false,
      '1000 received does not cover 1200 owed');
    assert.ok(!('solvent' in s),
      'lifetime income vs current liabilities is not a solvency claim');
    assert.match(s.note, /not an on-chain balance check/);
  });
});
