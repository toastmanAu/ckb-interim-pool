'use strict';
/**
 * Dust sweep and forfeiture.
 *
 * A miner who changes payout address strands their remaining balance: the old
 * address never earns again, so it never reaches POOL_MIN_PAYOUT_SHANNONS and
 * the worker never pays it. That happened on 2026-08-20 when k7-01 moved
 * addresses mid-PPLNS-window and left 304.12 CKB behind.
 *
 * The clock runs on the miner's last CREDIT, not their last share: blocks in
 * the PPLNS window keep settling for hours after a rig stops, and a
 * credit-based clock resets itself instead of needing a padded guess.
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
const LIMITS = { maxBatchShannons: '200000000000', maxDailyShannons: '1000000000000' };
const MINIMUM = '100000000000';           // 1000 CKB
const DUST = '30412301268';               // 304.12 CKB — the real stranded balance
const UNPAYABLE = '5000000000';           // 50 CKB — below the 61 CKB cell floor
const ADDR_A = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const ADDR_B = 'ckb1qyq9qjett7ngswt065q5t5ypk0p6c9sgqdlq8gfx5c';
const ADDR_C = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4';
const quiet = { log: () => {} };

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

async function reset(db) {
  await db.query(
    'TRUNCATE payout_items, payout_batches, treasury_receipts, ledger_entries, blocks, miners CASCADE');
}

/** Seed a miner credited `owed`, with that credit aged `daysAgo`. */
async function seedMiner(db, address, owed, daysAgo, key = address) {
  const id = String((await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ($1, 'ckb')
     ON CONFLICT (payout_address) DO UPDATE SET last_seen_at = now() RETURNING id`,
    [address])).rows[0].id);
  await postEntry(db, {
    accountType: ACCOUNTS.CONFIRMED,
    minerId: id,
    amountShannons: owed,
    referenceType: 'test',
    referenceId: 'dust-seed',
    idempotencyKey: `test:dust-seed:${key}`,
  });
  await db.query(
    `UPDATE ledger_entries SET created_at = now() - ($2 || ' days')::interval
      WHERE miner_id = $1`, [id, String(daysAgo)]);
  return id;
}

let receiptHeight = 90_000;
async function seedIncome(db, amountShannons) {
  const height = receiptHeight++;
  const blockId = (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
     VALUES ('dust-test', gen_random_uuid(), $1, $2, $3, 'CANONICAL_IMMATURE')
     RETURNING id`,
    [`dust-${height}`, `0x${height.toString(16)}`, height])).rows[0].id;
  await db.query(
    `INSERT INTO treasury_receipts
       (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
        lock_args, amount_shannons, mature_at_epoch, confirmed_at)
     VALUES ($1, $2::bigint, $2::bigint + 11, $3, 0, $4, $5, 1, now())`,
    [blockId, height, `0x${height.toString(16).padStart(64, '0')}`,
      `0x${'ab'.repeat(20)}`, amountShannons]);
}

function refusingBuilder() {
  return { async buildBatchTransfer() { throw new Error('must not build this batch'); } };
}

function worker(db, opts = {}) {
  return createPayoutWorker({
    db, txBuilder: refusingBuilder(), limits: LIMITS, logger: quiet,
    minimumPayoutShannons: MINIMUM, ...opts,
  });
}

test('dust sweep', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('a stranded balance is swept once its miner stops earning', async () => {
    await reset(db);
    const minerId = await seedMiner(db, ADDR_A, DUST, 4);
    await seedIncome(db, '300000000000');

    const eligible = await worker(db, { dustInactiveDays: 3 }).eligibleMiners();

    assert.deepStrictEqual(eligible.map(m => ({ miner: String(m.miner_id), bal: m.balance, dust: m.dust })),
      [{ miner: minerId, bal: DUST, dust: true }]);
  });

  await t.test('a miner still receiving credits is left alone', async () => {
    await reset(db);
    await seedMiner(db, ADDR_A, DUST, 2);
    await seedIncome(db, '300000000000');

    assert.deepStrictEqual(await worker(db, { dustInactiveDays: 3 }).eligibleMiners(), []);
  });

  // Reachable state: a HELD proposal is reserved for the amount the operator
  // approved, so a balance that GREW while the batch sat held leaves a recent
  // negative confirmed entry above an older positive one. Being paid is not
  // earning — if a reservation reset the clock, nobody the pool has ever paid
  // would become sweepable.
  await t.test('a payout reservation does not reset the dust clock', async () => {
    await reset(db);
    const minerId = await seedMiner(db, ADDR_A, '180412301268', 4);
    await postEntry(db, {
      accountType: ACCOUNTS.CONFIRMED,
      minerId,
      amountShannons: '-150000000000',
      referenceType: 'test',
      referenceId: 'dust-seed',
      idempotencyKey: 'test:dust-seed:reservation',
    });
    await seedIncome(db, '300000000000');

    const eligible = await worker(db, { dustInactiveDays: 3 }).eligibleMiners();

    assert.deepStrictEqual(eligible.map(m => ({ miner: String(m.miner_id), bal: m.balance, dust: m.dust })),
      [{ miner: minerId, bal: DUST, dust: true }]);
  });

  await t.test('a balance below its own cell floor is never swept', async () => {
    await reset(db);
    await seedMiner(db, ADDR_A, UNPAYABLE, 30);
    await seedIncome(db, '300000000000');

    assert.deepStrictEqual(await worker(db, { dustInactiveDays: 3 }).eligibleMiners(), []);
  });

  await t.test('a normal payable is unaffected by the dust clock', async () => {
    await reset(db);
    const minerId = await seedMiner(db, ADDR_A, '150000000000', 0);
    await seedIncome(db, '300000000000');

    const eligible = await worker(db, { dustInactiveDays: 3 }).eligibleMiners();

    assert.deepStrictEqual(eligible.map(m => ({ miner: String(m.miner_id), dust: m.dust })),
      [{ miner: minerId, dust: false }]);
  });

  // createBatch re-checks `owed < minimum` per candidate. Without teaching that
  // second gate about dust, eligibleMiners hands it candidates it silently drops.
  await t.test('a dust candidate survives the per-candidate gate in createBatch', async () => {
    await reset(db);
    const minerId = await seedMiner(db, ADDR_A, DUST, 4);
    await seedIncome(db, '300000000000');
    const w = worker(db, { dustInactiveDays: 3 });

    const batch = await w.createBatch(await w.eligibleMiners());

    assert.deepStrictEqual({ items: batch.items, state: batch.state }, { items: 1, state: 'RESERVED' });
    const item = (await db.query(
      'SELECT miner_id::text, amount_shannons FROM payout_items WHERE batch_id = $1',
      [batch.batchId])).rows[0];
    assert.deepStrictEqual(item, { miner_id: minerId, amount_shannons: DUST });
  });

  await t.test('dust is still subject to the payout caps', async () => {
    await reset(db);
    await seedMiner(db, ADDR_A, '90000000000', 4, 'a');
    await seedMiner(db, ADDR_B, '90000000000', 4, 'b');
    await seedMiner(db, ADDR_C, '90000000000', 4, 'c');
    await seedIncome(db, '400000000000');
    const w = worker(db, { dustInactiveDays: 3 });

    const batch = await w.createBatch(await w.eligibleMiners());

    assert.strictEqual(batch.state, 'HELD');
    const row = (await db.query(
      'SELECT held_reason FROM payout_batches WHERE id = $1', [batch.batchId])).rows[0];
    assert.match(row.held_reason, /per-batch/i);
  });

  await t.test('an undecodable payout address is skipped, not thrown', async () => {
    await reset(db);
    const good = await seedMiner(db, ADDR_A, DUST, 4, 'good');
    await seedMiner(db, 'ckb1qbroken', DUST, 4, 'broken');
    await seedIncome(db, '300000000000');

    const eligible = await worker(db, { dustInactiveDays: 3 }).eligibleMiners();

    assert.deepStrictEqual(eligible.map(m => String(m.miner_id)), [good]);
  });
});

test('forfeiture of unpayable balances', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('is disabled by default so no deploy confiscates by accident', async () => {
    await reset(db);
    const minerId = await seedMiner(db, ADDR_A, UNPAYABLE, 400);

    assert.deepStrictEqual(await worker(db).forfeitUnpayable(), []);
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), UNPAYABLE);
  });

  await t.test('moves a long-dormant unpayable balance to the pool fee', async () => {
    await reset(db);
    const minerId = await seedMiner(db, ADDR_A, UNPAYABLE, 91);

    const forfeited = await worker(db, { forfeitAfterDays: 90 }).forfeitUnpayable();

    assert.deepStrictEqual(forfeited, [{ minerId, amountShannons: UNPAYABLE }]);
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), '0');
    const fee = (await db.query(
      `SELECT COALESCE(sum(amount_shannons), 0)::text AS total FROM ledger_entries
        WHERE account_type = $1`, [ACCOUNTS.POOL_FEE])).rows[0].total;
    assert.strictEqual(fee, UNPAYABLE);
  });

  await t.test('running twice does not forfeit the same balance again', async () => {
    await reset(db);
    const minerId = await seedMiner(db, ADDR_A, UNPAYABLE, 91);
    const w = worker(db, { forfeitAfterDays: 90 });

    await w.forfeitUnpayable();
    assert.deepStrictEqual(await w.forfeitUnpayable(), []);

    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), '0');
    const fee = (await db.query(
      `SELECT COALESCE(sum(amount_shannons), 0)::text AS total FROM ledger_entries
        WHERE account_type = $1`, [ACCOUNTS.POOL_FEE])).rows[0].total;
    assert.strictEqual(fee, UNPAYABLE);
  });

  await t.test('leaves an unpayable balance that is still within the dormancy window', async () => {
    await reset(db);
    const minerId = await seedMiner(db, ADDR_A, UNPAYABLE, 89);

    assert.deepStrictEqual(await worker(db, { forfeitAfterDays: 90 }).forfeitUnpayable(), []);
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), UNPAYABLE);
  });

  await t.test('never touches a balance large enough to pay', async () => {
    await reset(db);
    const dusty = await seedMiner(db, ADDR_A, DUST, 400, 'dusty');
    const rich = await seedMiner(db, ADDR_B, '150000000000', 400, 'rich');

    assert.deepStrictEqual(await worker(db, { forfeitAfterDays: 90 }).forfeitUnpayable(), []);
    assert.strictEqual((await balanceFor(db, dusty, [ACCOUNTS.CONFIRMED])).toString(), DUST);
    assert.strictEqual((await balanceFor(db, rich, [ACCOUNTS.CONFIRMED])).toString(), '150000000000');
  });
});
