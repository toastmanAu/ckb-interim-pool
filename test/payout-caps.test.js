'use strict';
/**
 * Capped batch construction. HELD preserves the exact proposal for audit and
 * future sweep-liability accounting, but does not reserve ledger value until
 * an operator releases it.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { createPayoutWorker } = require('../src/wallet/payout-worker.js');
const { postEntry, balanceFor, ACCOUNTS } = require('../src/accounting/ledger.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const LIMITS = {
  maxBatchShannons: '200000000000',
  maxDailyShannons: '1000000000000',
};

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

async function reset(db) {
  await db.query(
    'TRUNCATE payout_items, payout_batches, treasury_receipts, ledger_entries, blocks, miners CASCADE');
}

async function seedMiner(db, address, owedShannons, key = address) {
  const id = (await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ($1, 'ckb')
     ON CONFLICT (payout_address) DO UPDATE SET last_seen_at = now() RETURNING id`,
    [address])).rows[0].id;
  await postEntry(db, {
    accountType: ACCOUNTS.CONFIRMED,
    minerId: id,
    amountShannons: owedShannons,
    referenceType: 'test',
    referenceId: 'seed',
    idempotencyKey: `test:cap-seed:${key}`,
  });
  return String(id);
}

let receiptHeight = 50_000;
async function seedIncome(db, amountShannons) {
  const height = receiptHeight++;
  const blockId = (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
     VALUES ('cap-test', gen_random_uuid(), $1, $2, $3, 'CANONICAL_IMMATURE')
     RETURNING id`,
    [`cap-${height}`, `0x${height.toString(16)}`, height])).rows[0].id;
  await db.query(
    `INSERT INTO treasury_receipts
       (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
        lock_args, amount_shannons, mature_at_epoch, confirmed_at)
     VALUES ($1, $2::bigint, $2::bigint + 11, $3, 0, $4, $5, 1, now())`,
    [blockId, height, `0x${height.toString(16).padStart(64, '0')}`,
      `0x${'ab'.repeat(20)}`, amountShannons]);
}

function refusingBuilder() {
  return {
    async buildBatchTransfer() {
      throw new Error('must not build a HELD or insolvent batch');
    },
  };
}

function recordingBuilder() {
  const calls = [];
  return {
    calls,
    async buildBatchTransfer({ items }) {
      calls.push(items);
      return {
        async broadcast() {
          return { ok: true, txHash: `0x${'42'.repeat(32)}` };
        },
      };
    },
  };
}

test('cap and solvency enforcement at batch construction',
  { timeout: 60000, skip: !dbReady }, async t => {
    const db = createDb(DB_URL);
    t.after(() => db.close());
    await db.migrate(MIGRATIONS);
    const quiet = { log: () => {} };

    await t.test('a solvent batch within caps is RESERVED', async () => {
      await reset(db);
      const minerId = await seedMiner(db, 'ckb1qcaptest0001', '150000000000');
      await seedIncome(db, '300000000000');
      const worker = createPayoutWorker({
        db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
      });

      const batch = await worker.createBatch(await worker.eligibleMiners());

      assert.deepStrictEqual(
        { items: batch.items, state: batch.state }, { items: 1, state: 'RESERVED' });
      const item = (await db.query(
        'SELECT state, amount_shannons FROM payout_items WHERE batch_id = $1',
        [batch.batchId])).rows[0];
      assert.deepStrictEqual(item, { state: 'RESERVED', amount_shannons: '150000000000' });
      assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), '0');
      assert.strictEqual(
        (await balanceFor(db, minerId, [ACCOUNTS.PENDING_PAYOUT])).toString(), '150000000000');
    });

    await t.test('an over-cap batch parks with its exact items and reserves no ledger value', async () => {
      await reset(db);
      const minerId = await seedMiner(db, 'ckb1qcaptest0002', '250000000000');
      await seedIncome(db, '300000000000');
      const worker = createPayoutWorker({
        db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
      });

      const batch = await worker.runOnce();

      assert.deepStrictEqual(
        { items: batch.items, state: batch.state }, { items: 1, state: 'HELD' });
      const row = (await db.query(
        'SELECT state, held_reason FROM payout_batches WHERE id = $1', [batch.batchId])).rows[0];
      assert.strictEqual(row.state, 'HELD');
      assert.match(row.held_reason, /per-batch/i);
      const item = (await db.query(
        'SELECT miner_id::text, amount_shannons, state FROM payout_items WHERE batch_id = $1',
        [batch.batchId])).rows[0];
      assert.deepStrictEqual(item,
        { miner_id: minerId, amount_shannons: '250000000000', state: 'HELD' });
      assert.strictEqual(
        (await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), '250000000000');
      assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.PENDING_PAYOUT])).toString(), '0');

      assert.strictEqual(await worker.runOnce(), null, 'a parked proposal must not duplicate each tick');
      assert.strictEqual(
        (await db.query('SELECT count(*)::int count FROM payout_batches')).rows[0].count, 1);
    });

    await t.test('the rolling daily limit parks an otherwise valid batch', async () => {
      await reset(db);
      const oldMiner = await seedMiner(db, 'ckb1qcaptest-old', '1', 'old');
      const currentMiner = await seedMiner(db, 'ckb1qcaptest0003', '100000000000');
      await seedIncome(db, '200000000000');
      const oldBatch = (await db.query(
        `INSERT INTO payout_batches (id, state, broadcast_at)
         VALUES (gen_random_uuid(), 'BROADCAST', now()) RETURNING id`)).rows[0].id;
      await db.query(
        `INSERT INTO payout_items (batch_id, miner_id, amount_shannons, state)
         VALUES ($1, $2, '950000000000', 'BROADCAST')`, [oldBatch, oldMiner]);
      const worker = createPayoutWorker({
        db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
      });

      const batch = await worker.createBatch([{ miner_id: currentMiner, balance: '100000000000' }]);

      assert.strictEqual(batch.state, 'HELD');
      const reason = (await db.query(
        'SELECT held_reason FROM payout_batches WHERE id = $1', [batch.batchId])).rows[0].held_reason;
      assert.match(reason, /24h|daily/i);
    });

    await t.test('an audited release reserves and pays the preserved proposal exactly once', async () => {
      await reset(db);
      const minerId = await seedMiner(db, 'ckb1qcaptest0004', '250000000000');
      await seedIncome(db, '300000000000');
      const builder = recordingBuilder();
      const worker = createPayoutWorker({ db, txBuilder: builder, limits: LIMITS, logger: quiet });
      const batch = await worker.runOnce();
      assert.strictEqual(batch.state, 'HELD');
      assert.strictEqual(builder.calls.length, 0);

      await db.query(
        `UPDATE payout_batches
            SET state = 'RESERVED', released_by = 'operator', released_at = now()
          WHERE id = $1 AND state = 'HELD'`, [batch.batchId]);
      await worker.runOnce();

      assert.deepStrictEqual(builder.calls, [[{
        address: 'ckb1qcaptest0004', capacityShannons: '250000000000',
      }]]);
      const states = (await db.query(
        `SELECT b.state batch_state, i.state item_state
           FROM payout_batches b JOIN payout_items i ON i.batch_id = b.id
          WHERE b.id = $1`, [batch.batchId])).rows[0];
      assert.deepStrictEqual(states, { batch_state: 'BROADCAST', item_state: 'BROADCAST' });
      assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), '0');
      assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.PENDING_PAYOUT])).toString(), '0');
      assert.strictEqual(
        (await balanceFor(db, minerId, [ACCOUNTS.PAID])).toString(), '250000000000');

      await worker.runOnce();
      assert.strictEqual(builder.calls.length, 1, 'released batch must never broadcast twice');
    });

    await t.test('insolvency refuses all batches and raises an incident signal', async () => {
      await reset(db);
      await seedMiner(db, 'ckb1qcaptest0005', '100000000000');
      const logs = [];
      const worker = createPayoutWorker({
        db,
        txBuilder: refusingBuilder(),
        limits: LIMITS,
        logger: { log: (...parts) => logs.push(parts.join(' ')) },
      });

      const batch = await worker.createBatch(await worker.eligibleMiners());

      assert.strictEqual(batch, null);
      assert.strictEqual((await db.query('SELECT count(*)::int count FROM payout_batches')).rows[0].count, 0);
      assert.strictEqual((await db.query('SELECT count(*)::int count FROM payout_items')).rows[0].count, 0);
      assert.strictEqual(worker.stats.insolvency, 1);
      assert.match(logs.join('\n'), /INSOLVENCY|INCIDENT/i);
    });

    await t.test('candidate input cannot pay a miner above their current confirmed balance', async () => {
      await reset(db);
      const minerId = await seedMiner(db, 'ckb1qcaptest0006', '100000000000');
      await seedIncome(db, '200000000000');
      const worker = createPayoutWorker({
        db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
      });

      const batch = await worker.createBatch([
        { miner_id: minerId, balance: '999999999999999999' },
      ]);

      assert.strictEqual(batch.state, 'RESERVED');
      const amount = (await db.query(
        'SELECT amount_shannons FROM payout_items WHERE batch_id = $1', [batch.batchId])).rows[0]
        .amount_shannons;
      assert.strictEqual(amount, '100000000000');
    });
  });
