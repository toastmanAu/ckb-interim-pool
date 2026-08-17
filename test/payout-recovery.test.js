'use strict';
/** Recovery must reconcile durable tx evidence before any new payout. */
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
const TX = '0x' + 'bb'.repeat(32);
const PARENT = '0x' + 'aa'.repeat(32);
const AMOUNT = '100000000000';
const FEE = '1000';
const LIMITS = {
  maxBatchShannons: '200000000000',
  maxDailyShannons: '1000000000000',
};

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

async function reset(db) {
  await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
}

function makeNode(status) {
  return {
    async rpc(method, [hash]) {
      if (method !== 'get_transaction') throw new Error(`unexpected rpc ${method}`);
      if (hash === TX) {
        if (!status) return null;
        return {
          transaction: {
            hash: TX,
            inputs: [{ previous_output: { tx_hash: PARENT, index: '0x0' } }],
            outputs: [{ capacity: '0x' + BigInt(AMOUNT).toString(16) }],
          },
          tx_status: { status },
        };
      }
      if (hash === PARENT) {
        return {
          transaction: {
            hash: PARENT,
            outputs: [{ capacity: '0x' + (BigInt(AMOUNT) + BigInt(FEE)).toString(16) }],
          },
          tx_status: { status: 'committed' },
        };
      }
      return null;
    },
  };
}

async function seedPendingBatch(db, state, { feeShannons = null } = {}) {
  const minerId = (await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ('ckb1qrecover', 'ckb')
     ON CONFLICT (payout_address) DO UPDATE SET last_seen_at = now() RETURNING id`)).rows[0].id;
  const batchId = (await db.query(
    `INSERT INTO payout_batches
       (id, state, built_at, broadcast_at, tx_hash, raw_tx_or_ref, fee_shannons)
     VALUES (gen_random_uuid(), $1, now(),
             CASE WHEN $1 = 'BROADCAST' THEN now() ELSE NULL END,
             $2, '{"signed":true}', $3)
     RETURNING id`, [state, TX, feeShannons])).rows[0].id;
  await db.query(
    `INSERT INTO payout_items (batch_id, miner_id, amount_shannons, state)
     VALUES ($1, $2, $3, $4)`,
    [batchId, minerId, AMOUNT, state === 'BUILT' ? 'RESERVED' : 'BROADCAST']);
  await postEntry(db, {
    accountType: ACCOUNTS.PENDING_PAYOUT,
    minerId,
    amountShannons: AMOUNT,
    referenceType: 'payout',
    referenceId: String(batchId),
    idempotencyKey: `payout:reserve:${batchId}:${minerId}:pending`,
  });
  return { batchId: String(batchId), minerId: String(minerId) };
}

function refusingBuilder() {
  return {
    async buildBatchTransfer() {
      throw new Error('must not build while transaction evidence is unreconciled');
    },
  };
}

test('payout crash recovery', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  const quiet = { log() {} };

  await t.test('process persists BUILT evidence before calling broadcast', async () => {
    await reset(db);
    const { batchId } = await seedPendingBatch(db, 'BUILT', { feeShannons: FEE });
    await db.query(
      `UPDATE payout_batches SET state = 'RESERVED', built_at = NULL,
              tx_hash = NULL, raw_tx_or_ref = NULL, fee_shannons = NULL
        WHERE id = $1`, [batchId]);
    let observed;
    const worker = createPayoutWorker({
      db,
      limits: LIMITS,
      logger: quiet,
      txBuilder: {
        async buildBatchTransfer() {
          return {
            txHash: TX,
            rawTx: { signed: true },
            feeShannons: FEE,
            async broadcast() {
              observed = (await db.query(
                `SELECT state, tx_hash, raw_tx_or_ref, fee_shannons
                   FROM payout_batches WHERE id = $1`, [batchId])).rows[0];
              return { ok: true, txHash: TX };
            },
          };
        },
      },
    });

    const txHash = await worker.processBatch(batchId);

    assert.strictEqual(txHash, TX);
    assert.deepStrictEqual(observed, {
      state: 'BUILT',
      tx_hash: TX,
      raw_tx_or_ref: '{"signed":true}',
      fee_shannons: FEE,
    });
    const row = (await db.query(
      'SELECT state FROM payout_batches WHERE id = $1', [batchId])).rows[0];
    assert.strictEqual(row.state, 'BROADCAST');
    assert.strictEqual((await balanceFor(db, (await db.query(
      'SELECT miner_id FROM payout_items WHERE batch_id = $1', [batchId])).rows[0].miner_id,
    [ACCOUNTS.PAID])).toString(), '0', 'broadcast is not confirmation');
  });

  await t.test('a committed BROADCAST batch confirms and books paid plus exact fee once', async () => {
    await reset(db);
    const { batchId, minerId } = await seedPendingBatch(db, 'BROADCAST');
    const worker = createPayoutWorker({
      db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
    });

    await worker.recoverPendingBatches(makeNode('committed'));
    await worker.recoverPendingBatches(makeNode('committed'));

    const row = (await db.query(
      'SELECT state, confirmed_at, fee_shannons FROM payout_batches WHERE id = $1',
      [batchId])).rows[0];
    assert.strictEqual(row.state, 'CONFIRMED');
    assert.ok(row.confirmed_at);
    assert.strictEqual(row.fee_shannons, FEE);
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.PAID])).toString(), AMOUNT);
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.PENDING_PAYOUT])).toString(), '0');
    const fee = (await db.query(
      `SELECT COALESCE(sum(amount_shannons),0)::text total, count(*)::int count
         FROM ledger_entries WHERE account_type = $1`, [ACCOUNTS.TX_FEE])).rows[0];
    assert.deepStrictEqual(fee, { total: FEE, count: 1 });
  });

  await t.test('a crash-left BUILT batch found committed is confirmed without rebuilding', async () => {
    await reset(db);
    const { batchId } = await seedPendingBatch(db, 'BUILT', { feeShannons: FEE });
    const worker = createPayoutWorker({
      db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
    });

    await worker.recoverPendingBatches(makeNode('committed'));

    assert.strictEqual((await db.query(
      'SELECT state FROM payout_batches WHERE id = $1', [batchId])).rows[0].state, 'CONFIRMED');
  });

  await t.test('proposed is BROADCAST but not paid or confirmed', async () => {
    await reset(db);
    const { batchId, minerId } = await seedPendingBatch(db, 'BUILT', { feeShannons: FEE });
    const worker = createPayoutWorker({
      db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
    });

    await worker.recoverPendingBatches(makeNode('proposed'));

    assert.strictEqual((await db.query(
      'SELECT state FROM payout_batches WHERE id = $1', [batchId])).rows[0].state, 'BROADCAST');
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.PAID])).toString(), '0');
  });

  await t.test('absent crash-left BUILT evidence remains BUILT', async () => {
    await reset(db);
    const { batchId, minerId } = await seedPendingBatch(db, 'BUILT', { feeShannons: FEE });
    const worker = createPayoutWorker({
      db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
    });

    assert.strictEqual(await worker.runOnce(makeNode(null)), null);

    assert.strictEqual((await db.query(
      'SELECT state FROM payout_batches WHERE id = $1', [batchId])).rows[0].state, 'BUILT');
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.PAID])).toString(), '0');
    assert.strictEqual((await db.query(
      'SELECT count(*)::int count FROM payout_batches')).rows[0].count, 1);
  });

  await t.test('absent transaction evidence stays unresolved and blocks new work', async () => {
    await reset(db);
    const { batchId } = await seedPendingBatch(db, 'BROADCAST', { feeShannons: FEE });
    const worker = createPayoutWorker({
      db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
    });

    assert.strictEqual(await worker.runOnce(makeNode(null)), null);

    assert.strictEqual((await db.query(
      'SELECT state FROM payout_batches WHERE id = $1', [batchId])).rows[0].state, 'BROADCAST');
    assert.strictEqual((await db.query(
      'SELECT count(*)::int count FROM payout_batches')).rows[0].count, 1);
  });
});
