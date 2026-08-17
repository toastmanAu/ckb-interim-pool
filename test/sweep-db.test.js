'use strict';
/** Durable cold-address trust and unpaid-liability derivation. */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { createDb } = require('../src/accounting/db.js');
const { postEntry, ACCOUNTS } = require('../src/accounting/ledger.js');
const {
  checkColdAddressTofu,
  owedUnpaidShannons,
  createColdSweepWorker,
} = require('../src/wallet/sweep.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const COLD = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const SWEEP_TX = '0x' + '77'.repeat(32);

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

async function miner(db, address) {
  return String((await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ($1, 'ckb') RETURNING id`,
    [address])).rows[0].id);
}

async function entry(db, minerId, accountType, amount, key) {
  await postEntry(db, {
    accountType,
    minerId,
    amountShannons: amount,
    referenceType: 'test',
    referenceId: 'sweep-liability',
    idempotencyKey: `test:sweep:${key}`,
  });
}

test('cold sweep database policy', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('wallet_sweeps provides durable transaction evidence and history', async () => {
    const exists = (await db.query(
      `SELECT to_regclass('public.wallet_sweeps') IS NOT NULL AS exists`)).rows[0].exists;
    assert.strictEqual(exists, true);
  });

  await t.test('first use is durable and a changed address is refused without mutation', async () => {
    await db.query('TRUNCATE wallet_config');

    assert.deepStrictEqual(await checkColdAddressTofu(db, 'ckb1first'), { ok: true, reason: null });
    assert.deepStrictEqual(await checkColdAddressTofu(db, 'ckb1first'), { ok: true, reason: null });
    const changed = await checkColdAddressTofu(db, 'ckb1changed');

    assert.strictEqual(changed.ok, false);
    assert.match(changed.reason, /changed|approve/i);
    assert.strictEqual((await db.query(
      'SELECT cold_address FROM wallet_config WHERE id = 1')).rows[0].cold_address, 'ckb1first');
  });

  await t.test('concurrent first use trusts exactly one of two different addresses', async () => {
    await db.query('TRUNCATE wallet_config');

    const results = await Promise.all([
      checkColdAddressTofu(db, 'ckb1concurrent-a'),
      checkColdAddressTofu(db, 'ckb1concurrent-b'),
    ]);

    assert.strictEqual(results.filter(result => result.ok).length, 1);
    const recorded = (await db.query(
      'SELECT cold_address FROM wallet_config WHERE id = 1')).rows[0].cold_address;
    assert.ok(['ckb1concurrent-a', 'ckb1concurrent-b'].includes(recorded));
  });

  await t.test('unpaid debt includes HELD and RESERVED value exactly once', async () => {
    await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
    const heldMiner = await miner(db, 'ckb1sweep-held');
    const reservedMiner = await miner(db, 'ckb1sweep-reserved');
    const negativeMiner = await miner(db, 'ckb1sweep-negative');

    await entry(db, heldMiner, ACCOUNTS.CONFIRMED, '100', 'held-confirmed');
    await entry(db, reservedMiner, ACCOUNTS.CONFIRMED, '200', 'reserved-confirmed');
    await entry(db, reservedMiner, ACCOUNTS.CONFIRMED, '-200', 'reserved-remove');
    await entry(db, reservedMiner, ACCOUNTS.PENDING_PAYOUT, '200', 'reserved-pending');
    await entry(db, negativeMiner, ACCOUNTS.CONFIRMED, '-50', 'negative');

    const heldBatch = (await db.query(
      `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'HELD') RETURNING id`)).rows[0].id;
    const reservedBatch = (await db.query(
      `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'RESERVED') RETURNING id`)).rows[0].id;
    await db.query(
      `INSERT INTO payout_items (batch_id, miner_id, amount_shannons, state)
       VALUES ($1, $2, 100, 'HELD'), ($3, $4, 200, 'RESERVED')`,
      [heldBatch, heldMiner, reservedBatch, reservedMiner]);

    assert.strictEqual(await owedUnpaidShannons(db, ACCOUNTS), '300');
  });

  await t.test('sweep evidence is BUILT before broadcast and uses only calculated surplus', async () => {
    await db.query(
      'TRUNCATE wallet_sweeps, wallet_config, treasury_snapshots, payout_items, payout_batches, ledger_entries, miners CASCADE');
    const minerId = await miner(db, 'ckb1sweep-worker');
    await entry(db, minerId, ACCOUNTS.CONFIRMED, '300', 'worker-owed');
    await db.query(
      `INSERT INTO treasury_snapshots
         (lock_args, total_shannons, spendable_shannons, cell_count, owed_shannons)
       VALUES ('0xpool', 900, 900, 1, 300)`);

    let observed;
    const worker = createColdSweepWorker({
      db,
      coldAddress: COLD,
      treasuryLockArgs: '0xpool',
      floatShannons: '500',
      logger: { log() {} },
      txBuilder: {
        async buildTransfer({ toAddress, capacityShannons }) {
          assert.strictEqual(toAddress, COLD);
          assert.strictEqual(capacityShannons, '100');
          return {
            txHash: SWEEP_TX,
            rawTx: { signed: true },
            feeShannons: '2',
            async broadcast() {
              observed = (await db.query(
                `SELECT state, cold_address, amount_shannons, tx_hash, raw_tx_or_ref, fee_shannons
                   FROM wallet_sweeps`)).rows[0];
              return { ok: true, txHash: SWEEP_TX };
            },
          };
        },
      },
    });

    const result = await worker.runOnce();

    assert.strictEqual(result.txHash, SWEEP_TX);
    assert.deepStrictEqual(observed, {
      state: 'BUILT',
      cold_address: COLD,
      amount_shannons: '100',
      tx_hash: SWEEP_TX,
      raw_tx_or_ref: '{"signed":true}',
      fee_shannons: '2',
    });
    assert.strictEqual((await db.query('SELECT state FROM wallet_sweeps')).rows[0].state, 'BROADCAST');
  });

  await t.test('committed sweep evidence confirms without rebuilding', async () => {
    await db.query('TRUNCATE wallet_sweeps, wallet_config');
    const id = (await db.query(
      `INSERT INTO wallet_sweeps
         (state, cold_address, amount_shannons, built_at, broadcast_at,
          tx_hash, raw_tx_or_ref, fee_shannons)
       VALUES ('BROADCAST', $1, 100, now(), now(), $2, '{}', 2)
       RETURNING id::text`, [COLD, SWEEP_TX])).rows[0].id;
    const worker = createColdSweepWorker({
      db,
      coldAddress: COLD,
      treasuryLockArgs: '0xpool',
      floatShannons: '500',
      logger: { log() {} },
      txBuilder: { async buildTransfer() { throw new Error('must not rebuild'); } },
    });

    await worker.recoverPendingSweeps({
      async rpc(method, [txHash]) {
        assert.strictEqual(method, 'get_transaction');
        assert.strictEqual(txHash, SWEEP_TX);
        return { tx_status: { status: 'committed' } };
      },
    });

    const row = (await db.query(
      'SELECT state, confirmed_at FROM wallet_sweeps WHERE id = $1', [id])).rows[0];
    assert.strictEqual(row.state, 'CONFIRMED');
    assert.ok(row.confirmed_at);
  });

  await t.test('proposed BUILT evidence becomes BROADCAST but is never rebuilt', async () => {
    await db.query('TRUNCATE wallet_sweeps, wallet_config');
    const id = (await db.query(
      `INSERT INTO wallet_sweeps
         (state, cold_address, amount_shannons, built_at, tx_hash, raw_tx_or_ref, fee_shannons)
       VALUES ('BUILT', $1, 100, now(), $2, '{}', 2)
       RETURNING id::text`, [COLD, SWEEP_TX])).rows[0].id;
    const worker = createColdSweepWorker({
      db,
      coldAddress: COLD,
      treasuryLockArgs: '0xpool',
      logger: { log() {} },
      txBuilder: { async buildTransfer() { throw new Error('must not rebuild'); } },
    });

    await worker.recoverPendingSweeps({
      async rpc() { return { tx_status: { status: 'proposed' } }; },
    });

    assert.strictEqual((await db.query(
      'SELECT state FROM wallet_sweeps WHERE id = $1', [id])).rows[0].state, 'BROADCAST');
  });

  await t.test('absent BUILT evidence stays unresolved and blocks new sweep work', async () => {
    await db.query('TRUNCATE wallet_sweeps, wallet_config');
    const id = (await db.query(
      `INSERT INTO wallet_sweeps
         (state, cold_address, amount_shannons, built_at, tx_hash, raw_tx_or_ref, fee_shannons)
       VALUES ('BUILT', $1, 100, now(), $2, '{}', 2)
       RETURNING id::text`, [COLD, SWEEP_TX])).rows[0].id;
    const worker = createColdSweepWorker({
      db,
      coldAddress: COLD,
      treasuryLockArgs: '0xpool',
      rpcClient: { async rpc() { return null; } },
      logger: { log() {} },
      txBuilder: { async buildTransfer() { throw new Error('must not rebuild'); } },
    });

    assert.strictEqual(await worker.runOnce(), null);
    assert.strictEqual((await db.query(
      'SELECT state FROM wallet_sweeps WHERE id = $1', [id])).rows[0].state, 'BUILT');
  });
});
