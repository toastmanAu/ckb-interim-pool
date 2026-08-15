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
function makeNode({ tipHeight, minedWitness = CASE.cellbaseWitness, payout = CASE.payoutBlock }) {
  const state = { tipHeight, payout };
  return {
    state,
    async rpc(method, params) {
      if (method === 'get_tip_header') {
        return { number: '0x' + state.tipHeight.toString(16), epoch: '0x4e8024c003994' };
      }
      if (method === 'get_block_by_number') {
        const h = parseInt(params[0], 16);
        if (h === CASE.blockHeight) {
          return { header: { number: params[0] }, transactions: [{ witnesses: [minedWitness] }] };
        }
        if (h === CASE.payoutBlockHeight) return state.payout;
        return null;
      }
      throw new Error('unexpected rpc ' + method);
    },
  };
}

async function seedBlock(db, height) {
  return (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
     VALUES ('au-test', gen_random_uuid(), 'j1', '0x1', $1, 'CANONICAL_IMMATURE') RETURNING id`,
    [height])).rows[0].id;
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
});
