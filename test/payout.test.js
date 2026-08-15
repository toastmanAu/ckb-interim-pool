'use strict';
/**
 * payout.test.js — payout reservation, idempotency, crash recovery,
 * no-double-pay guarantees.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const { createDb } = require('../src/accounting/db.js');
const { createPayoutWorker } = require('../src/payout/payout-worker.js');
const { createDryRunBuilder } = require('../src/payout/tx-builder.js');
const { postEntry, balanceFor, ACCOUNTS } = require('../src/accounting/ledger.js');

const { destructiveDbUrl } = require('./tools/test-db.js');
const DB_URL = destructiveDbUrl();   // refuses to point at the live database
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try {
  execSync(`docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1`);
  dbReady = true;
} catch { dbReady = false; }

const ADDR_A = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const ADDR_B = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4';

async function seedConfirmed(db, address, shannons, key = 'seed') {
  const m = await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ($1, 'ckb')
     ON CONFLICT (payout_address) DO NOTHING RETURNING id`,
    [address],
  );
  const minerId = String((m.rows[0] || (await db.query(`SELECT id FROM miners WHERE payout_address = $1`, [address])).rows[0]).id);
  await postEntry(db, {
    accountType: ACCOUNTS.CONFIRMED,
    minerId,
    amountShannons: String(shannons),
    referenceType: 'test',
    referenceId: 'seed',
    idempotencyKey: `test:seed:${key}:${address}`,
  });
  return minerId;
}

test('payout: reservation, broadcast, confirmation, no double-pay', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE payout_batches, payout_items, ledger_entries, miners CASCADE');

  const aId = await seedConfirmed(db, ADDR_A, 500_000_000_000n);   // 5000 CKB
  const bId = await seedConfirmed(db, ADDR_B, 200_000_000_000n);   // 2000 CKB
  const poolAddress = ADDR_A;
  const worker = createPayoutWorker({
    db,
    txBuilder: createDryRunBuilder({ payoutAddress: poolAddress }),
    minimumPayoutShannons: '100000000000',   // 1000 CKB floor
  });

  // ── sweep 1: both eligible ────────────────────────────────────────────────
  const batch1 = await worker.runOnce();
  assert.ok(batch1);
  assert.strictEqual(batch1.items, 2);
  const items = (await db.query('SELECT miner_id, state, amount_shannons FROM payout_items ORDER BY miner_id')).rows;
  assert.ok(items.every(i => i.state === 'BROADCAST'));
  const bat = (await db.query(`SELECT state FROM payout_batches WHERE id = $1`, [batch1.batchId])).rows[0];
  assert.strictEqual(bat.state, 'BROADCAST');

  // ledger moved: confirmed → pending → paid
  assert.strictEqual((await balanceFor(db, aId, [ACCOUNTS.CONFIRMED])).toString(), '0');
  assert.strictEqual((await balanceFor(db, aId, [ACCOUNTS.PENDING_PAYOUT])).toString(), '0');
  assert.strictEqual((await balanceFor(db, aId, [ACCOUNTS.PAID])).toString(), '500000000000');

  // ── sweep 2: nothing eligible → no new batch ─────────────────────────────
  const batch2 = await worker.runOnce();
  assert.strictEqual(batch2, null, 'reserved credits cannot be re-selected');
  const batches = (await db.query('SELECT count(*)::int c FROM payout_batches')).rows[0].c;
  assert.strictEqual(batches, 1, 'exactly one batch');

  // ── confirmation via mock node ────────────────────────────────────────────
  let confirmed = new Set();
  const mockRpc = {
    async rpc(method, [txHash]) {
      if (method === 'get_transaction') {
        if (confirmed.has(txHash)) return { tx_status: { status: 'committed' } };
        throw new Error('not found');
      }
      throw new Error('unexpected ' + method);
    },
  };
  // mark both paid txs as committed on-chain
  const paidTxs = (await db.query(
    `SELECT metadata->>'txHash' AS tx FROM ledger_entries WHERE reference_type='payout' AND account_type='miner_paid'`,
  )).rows.map(r => r.tx);
  paidTxs.forEach(tx => confirmed.add(tx));
  await worker.confirmBatch(batch1.batchId, mockRpc);
  const finalBatch = (await db.query(`SELECT state FROM payout_batches WHERE id = $1`, [batch1.batchId])).rows[0];
  assert.strictEqual(finalBatch.state, 'CONFIRMED');

  // ── crash recovery: a stale BROADCAST item must NOT double-pay ────────────
  // simulate: an item that was broadcast but the batch row was left CREATED
  await seedConfirmed(db, ADDR_B, 300_000_000_000n, 'seed2');
  const r = await worker.runOnce();
  assert.ok(r);
  // pretend we crashed right after broadcast: reset one item to RESERVED
  await db.query(
    `UPDATE payout_items SET state = 'RESERVED'
     WHERE id = (SELECT id FROM payout_items WHERE batch_id = $1 LIMIT 1)`,
    [r.batchId],
  );
  // recovery sees the ledger 'paid' entries + (mock) on-chain tx and re-marks
  await worker.recoverPendingBatches(mockRpc);
  await worker.confirmBatch(r.batchId, mockRpc);
  // the previously-paid amount must never have been sent twice: miner B was
  // paid 2000 in sweep 1 + 3000 in sweep 2 — exactly two payments, no
  // duplicate of either amount
  const paidTotal = (await db.query(
    `SELECT COALESCE(sum(amount_shannons),0)::text s, count(*)::int n FROM ledger_entries
     WHERE miner_id = $1 AND account_type = 'miner_paid'`,
    [bId],
  )).rows[0];
  assert.strictEqual(paidTotal.s, '500000000000', 'sum of two legitimate payments');
  assert.strictEqual(paidTotal.n, 2, 'no third (duplicate) payment');
});
