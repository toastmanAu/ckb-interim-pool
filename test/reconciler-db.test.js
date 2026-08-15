'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { createReconciler } = require('../src/wallet/reconciler.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const FX = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'treasury-receipts-mainnet.json'), 'utf8'));
const CASE = FX.cases[0];

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

/**
 * Serves the fixture's mined block and its payout block. `state.tipHeight` and
 * `state.payout` are mutable so a test can deepen the chain or swap the payout
 * block for a reorged one. `state.payout = null` models a node that has not
 * indexed that height.
 */
const MINED_HASH = '0x' + 'a7'.repeat(32);   // what the chain serves at height H

function makeNode({ tipHeight, minedWitness = CASE.cellbaseWitness, payout = CASE.payoutBlock,
                    minedHash = MINED_HASH }) {
  const state = { tipHeight, payout, minedHash };
  return {
    state,
    async rpc(method, params) {
      if (method === 'get_tip_header') {
        return { number: '0x' + state.tipHeight.toString(16), epoch: '0x4e8024c003994' };
      }
      if (method === 'get_block_by_number') {
        const h = parseInt(params[0], 16);
        if (h === CASE.blockHeight) {
          return {
            header: { number: params[0], hash: state.minedHash },
            transactions: [{ witnesses: [minedWitness] }],
          };
        }
        if (h === CASE.payoutBlockHeight) return state.payout;
        return null;
      }
      throw new Error('unexpected rpc ' + method);
    },
  };
}

async function seedBlock(db, height, blockHash = null) {
  return (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, block_hash, state)
     VALUES ('au-test', gen_random_uuid(), 'j1', '0x1', $1, $2, 'CANONICAL_IMMATURE') RETURNING id`,
    [height, blockHash])).rows[0].id;
}

test('receipt persistence', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  const quiet = { log: () => {} };

  await t.test('records a receipt with the real amount', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 });
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();
    const r = (await db.query('SELECT * FROM treasury_receipts WHERE block_id = $1', [id])).rows[0];
    assert.ok(r, 'receipt written');
    assert.strictEqual(r.amount_shannons, CASE.amountShannons);
    assert.strictEqual(r.lock_args, CASE.expectedLockArgs);
    assert.ok(r.confirmed_at, 'deep enough to confirm');
  });

  await t.test('does not confirm while the payout block is too shallow', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 2 });   // < confirmations
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();
    const r = (await db.query('SELECT * FROM treasury_receipts WHERE block_id = $1', [id])).rows[0];
    assert.ok(r, 'receipt seen');
    assert.strictEqual(r.confirmed_at, null, 'must not confirm at shallow depth');
  });

  await t.test('is idempotent — a second tick writes no duplicate', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 });
    const rec = createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet });
    await rec.tick();
    await rec.tick();
    const { rows } = await db.query('SELECT count(*)::int c FROM treasury_receipts');
    assert.strictEqual(rows[0].c, 1);
  });

  await t.test('voids a receipt whose payout block was reorged away', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 2 });
    const rec = createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet });
    await rec.tick();                       // seen, unconfirmed
    const replaced = JSON.parse(JSON.stringify(CASE.payoutBlock));
    replaced.transactions[0].hash = '0x' + 'cc'.repeat(32);   // different tx at that height
    node.state.payout = replaced;
    node.state.tipHeight = CASE.payoutBlockHeight + 50;
    await rec.tick();
    const r = (await db.query('SELECT * FROM treasury_receipts WHERE block_id = $1', [id])).rows[0];
    assert.ok(r.voided_at, 'a reorged receipt must be voided, not confirmed');
    assert.strictEqual(r.confirmed_at, null);
  });

  await t.test('a null block from the node records nothing', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 });
    node.state.payout = null;
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();
    const { rows } = await db.query('SELECT count(*)::int c FROM treasury_receipts');
    assert.strictEqual(rows[0].c, 0, 'missing evidence is not a zero receipt');
  });

  await t.test('a concurrent duplicate on the second unique key is a no-op, not a crash', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    await seedBlock(db, CASE.blockHeight);
    // simulate a racing tick that already claimed this cellbase output under a
    // DIFFERENT block row: that trips UNIQUE(payout_tx_hash, output_index),
    // which ON CONFLICT (block_id) does not cover
    const other = await seedBlock(db, CASE.blockHeight + 1000);
    await db.query(
      `INSERT INTO treasury_receipts
         (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
          lock_args, amount_shannons, mature_at_epoch)
       VALUES ($1, $2, $3, $4, 0, '0xaa', 1, 5)`,
      [other, CASE.blockHeight + 1000, CASE.payoutBlockHeight, CASE.payoutTxHash]);

    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 });
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();

    const { rows } = await db.query('SELECT count(*)::int c FROM treasury_receipts');
    assert.strictEqual(rows[0].c, 1,
      'the racing insert must be a no-op leaving one row, not throw');
  });

  // ── the block at H must be OUR block ────────────────────────────────────────
  // The tracker re-verifies canonicality only for NODE_ACCEPTED and ORPHANED
  // rows, and promotion to CANONICAL_IMMATURE can happen at depth 0 — so a
  // 1-block reorg right after ours lands leaves a permanently stale row. The
  // witness at that height then names the REPLACEMENT miner's lock, and its
  // H+11 output would be recorded as our income: internally consistent, and
  // a stranger's reward distributed to our miners.
  await t.test('a block the chain no longer serves at that height records nothing', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    await seedBlock(db, CASE.blockHeight, '0x' + 'de'.repeat(32));   // what we recorded
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 }); // chain serves 0xa7…
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();
    const { rows } = await db.query('SELECT count(*)::int c FROM treasury_receipts');
    assert.strictEqual(rows[0].c, 0,
      'a height whose block is not ours must record no receipt at all');
  });

  await t.test('a stored hash that matches the chain reconciles normally', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight, MINED_HASH);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 });
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();
    const r = (await db.query('SELECT * FROM treasury_receipts WHERE block_id = $1', [id])).rows[0];
    assert.ok(r, 'the hash check must not block our own block');
    assert.strictEqual(r.amount_shannons, CASE.amountShannons);
  });

  // ── a void must not be terminal ─────────────────────────────────────────────
  // An ordinary 1-block reorg at H+11 always changes the cellbase tx hash,
  // even when the new H+11 still pays us. Before migration 005 the voided row
  // held UNIQUE(block_id) forever, no replacement could be inserted, and
  // rewardForBlock returned null for good: one reorg stranded a real reward.
  await t.test('a voided receipt is superseded once a correct payout appears', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 2 });
    const rec = createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet });
    await rec.tick();                          // receipt seen, unconfirmed

    // reorg at H+11: a different cellbase tx, still paying our lock
    const replaced = JSON.parse(JSON.stringify(CASE.payoutBlock));
    replaced.transactions[0].hash = '0x' + 'cc'.repeat(32);
    node.state.payout = replaced;
    await rec.tick();                          // voided
    assert.strictEqual(
      (await db.query('SELECT count(*)::int c FROM treasury_receipts WHERE voided_at IS NOT NULL')).rows[0].c,
      1, 'the changed payout must be voided');

    node.state.tipHeight = CASE.payoutBlockHeight + 50;
    await rec.tick();                          // the replacement payout is now deep

    const live = (await db.query(
      `SELECT * FROM treasury_receipts WHERE block_id = $1 AND voided_at IS NULL`, [id])).rows;
    assert.strictEqual(live.length, 1, 'a fresh receipt must supersede the voided one');
    assert.ok(live[0].confirmed_at, 'and it must be able to confirm');
    assert.strictEqual(live[0].payout_tx_hash, replaced.transactions[0].hash);
    assert.strictEqual(live[0].amount_shannons, CASE.amountShannons);

    // and the block is allocatable again — the point of the whole exercise
    const { rewardForBlock } = require('../src/accounting/allocator.js');
    assert.strictEqual(await rewardForBlock(db, id), CASE.amountShannons);

    const voided = (await db.query(
      `SELECT count(*)::int c FROM treasury_receipts WHERE block_id = $1 AND voided_at IS NOT NULL`,
      [id])).rows[0].c;
    assert.strictEqual(voided, 1, 'the voided row stays as history, it is not deleted');
  });

  await t.test('a chain that reorgs BACK can re-record the original output', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 2 });
    const rec = createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet });
    await rec.tick();

    const replaced = JSON.parse(JSON.stringify(CASE.payoutBlock));
    replaced.transactions[0].hash = '0x' + 'cc'.repeat(32);
    node.state.payout = replaced;
    await rec.tick();                          // voided the original tx hash

    node.state.payout = CASE.payoutBlock;      // …and the chain reorgs back
    node.state.tipHeight = CASE.payoutBlockHeight + 50;
    await rec.tick();

    const live = (await db.query(
      `SELECT * FROM treasury_receipts WHERE block_id = $1 AND voided_at IS NULL`, [id])).rows;
    assert.strictEqual(live.length, 1,
      'the voided row must not hold (payout_tx_hash, output_index) hostage');
    assert.strictEqual(live[0].payout_tx_hash, CASE.payoutTxHash);
    assert.ok(live[0].confirmed_at);
  });
});
