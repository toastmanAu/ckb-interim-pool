'use strict';
/**
 * allocator.test.js — allocation + ledger: conservation, idempotency,
 * immutability.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const { createDb } = require('../src/accounting/db.js');
const { allocateMatureBlock, rewardForBlock } = require('../src/accounting/allocator.js');
const { balanceFor, verifyBlockConservation, ACCOUNTS } = require('../src/accounting/ledger.js');
const { uuidv7 } = require('../src/common/ids.js');

const { destructiveDbUrl } = require('./tools/test-db.js');
const DB_URL = destructiveDbUrl();   // refuses to point at the live database
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try {
  execSync(`docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1`);
  dbReady = true;
} catch { dbReady = false; }

const BOOT = 'aabbccdd00112233445566778899eef0';
const EDGE = 'test-edge-01';
const ADDR_A = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const ADDR_B = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4';

async function seedMiner(db, address, worker) {
  const m = await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ($1, 'ckb')
     ON CONFLICT (payout_address) DO NOTHING RETURNING id`,
    [address],
  );
  const minerId = m.rows[0]?.id || (await db.query(`SELECT id FROM miners WHERE payout_address = $1`, [address])).rows[0].id;
  const w = await db.query(
    `INSERT INTO workers (miner_id, worker_name) VALUES ($1, $2) RETURNING id`,
    [minerId, worker],
  );
  return { minerId: minerId.replace ? minerId : String(minerId), workerId: w.rows[0].id };
}

test('allocation + ledger: conservation, idempotency, immutable snapshot', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE ledger_entries, block_allocations, block_allocation_items, treasury_receipts, blocks, share_events, ingested_events, sessions, workers, miners, edge_boots, edges, config_snapshots CASCADE');

  const { minerId: aId } = await seedMiner(db, ADDR_A, 'k7-01');
  const { minerId: bId } = await seedMiner(db, ADDR_B, 'gs-1');
  const { minerId: cId } = await seedMiner(db, ADDR_B, 'gs-2');

  // share history: A and B (2 workers) — 8 shares, mixed work
  const workA = '2018634629120000000';   // ~470k diff
  const workB = '4294967296000000';      // 1M diff
  const t0 = Date.now();
  const shareIds = [];
  const shareSeq = [
    [aId, workA], [bId, workB], [aId, workA], [aId, workA],
    [bId, workB], [aId, workA], [bId, workB], [aId, workA],   // winning share last
  ];
  for (let i = 0; i < shareSeq.length; i++) {
    const [minerId, work] = shareSeq[i];
    const r = await db.query(
      `INSERT INTO share_events
         (id, edge_id, boot_id, edge_seq, session_id, miner_id, worker_id,
          job_id, template_work_id, work_units, assigned_target, pow_hash,
          nonce, hash, accepted_at, is_block_candidate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_timestamp($15/1000.0),$16)
       RETURNING id::text`,
      [uuidv7(), EDGE, BOOT, i + 1, uuidv7(), minerId, (await db.query('SELECT id FROM workers LIMIT 1')).rows[0].id,
       `job${i}`, '0x1', work, 'q', 'ab'.repeat(32), '0x' + i.toString(16).padStart(32, '0'),
       '0x' + 'ef'.repeat(32), t0 + i * 1000, i === shareSeq.length - 1],
    );
    shareIds.push(r.rows[0].id);
  }

  // the block: MATURE, template with compact target. Its stored
  // reward_shannons is deliberately a DIFFERENT (wrong, stranger's-reward)
  // figure than the treasury receipt: this proves allocation distributes
  // the receipt amount, not the stale column — restoring
  // `BigInt(block.reward_shannons)` inside the allocator would make this
  // test fail, not pass.
  const staleCellbaseReward = 82954427769n;   // 829.54 CKB — the wrong number
  const reward = 110000000000n;               // 1100 CKB — the receipt's true figure
  const blockR = await db.query(
    `INSERT INTO blocks (id, candidate_event_id, edge_id, boot_id, job_id, nonce, miner_id,
                         height, parent_hash, state, reward_shannons, template_json, block_epoch_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,123456,'0x' || repeat('00',31) || '01','MATURE',$8,
             $9::jsonb, '0x5')
     RETURNING id::text`,
    [uuidv7(), shareIds[shareIds.length - 1], EDGE, BOOT, 'job7', '0x' + 'aa'.repeat(16), aId,
     staleCellbaseReward.toString(), JSON.stringify({ compact_target: '0x19020000' })],
  );
  const blockId = blockR.rows[0].id;

  // reconciled treasury income (Task 4's pool-wallet output) — this is what
  // allocateMatureBlock now reads, not the block's own reward_shannons
  await db.query(
    `INSERT INTO treasury_receipts
       (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
        lock_args, amount_shannons, mature_at_epoch, confirmed_at)
     VALUES ($1, 123456, 123467, $2, 0, '0x5ea0977c3cab6898817c9860fe70d26acf559f76',
             $3, 100, now())`,
    [blockId, '0x' + 'cc'.repeat(32), reward.toString()],
  );

  // ── allocate ──────────────────────────────────────────────────────────────
  const r1 = await allocateMatureBlock(db, { blockId, windowNum: 2, windowDen: 1, feeBps: 100, logger: { log: () => {} } });
  assert.strictEqual(r1.allocated, true);

  const alloc = (await db.query(`SELECT * FROM block_allocations WHERE block_id = $1`, [blockId])).rows[0];
  assert.ok(alloc.allocation_hash.length === 64);
  const items = (await db.query(`SELECT * FROM block_allocation_items WHERE allocation_id = $1`, [alloc.id])).rows;
  assert.strictEqual(items.length, 2, 'two miner accounts credited');
  const sum = items.reduce((a, x) => a + BigInt(x.credit_shannons), 0n);
  const fee = BigInt(alloc.pool_fee_shannons);
  assert.strictEqual(sum + fee, reward, 'conservation: credits + fee == reward');
  assert.strictEqual(fee, reward / 100n, '1% fee exactly');

  // ledger state
  const aCredit = items.find(i => i.miner_id === aId) || items.find(i => String(i.miner_id).replace(/-/g, '') === String(aId).replace(/-/g, ''));
  assert.strictEqual((await balanceFor(db, aId, [ACCOUNTS.CONFIRMED])).toString(), aCredit.credit_shannons);
  assert.ok(await verifyBlockConservation(db, blockId, reward.toString()));
  assert.strictEqual((await db.query(`SELECT state FROM blocks WHERE id = $1`, [blockId])).rows[0].state, 'SETTLED_TO_LEDGER');

  // ── idempotency: a second attempt is a no-op ──────────────────────────────
  const r2 = await allocateMatureBlock(db, { blockId, windowNum: 2, windowDen: 1, feeBps: 100, logger: { log: () => {} } });
  assert.strictEqual(r2.allocated, false, 'cannot allocate twice');
  const entries = (await db.query(`SELECT count(*)::int c FROM ledger_entries WHERE reference_type='block' AND reference_id=$1`, [blockId])).rows[0].c;
  assert.strictEqual(entries, 3, '2 miner credits + pool fee, no duplicates');

  // ── orphaned / immature blocks cannot allocate ────────────────────────────
  const immature = (await db.query(
    `INSERT INTO blocks (id, candidate_event_id, edge_id, boot_id, job_id, nonce, state, reward_shannons)
     VALUES ($1,$2,$3,$4,$5,$6,'CANONICAL_IMMATURE',1000) RETURNING id::text`,
    [uuidv7(), shareIds[0], EDGE, BOOT, 'x', '0x' + 'bb'.repeat(16)],
  )).rows[0].id;
  assert.strictEqual((await allocateMatureBlock(db, { blockId: immature, feeBps: 100 })).allocated, false);
});

test('a block with no confirmed receipt is not allocated', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE treasury_receipts, blocks, share_events, ingested_events, sessions, workers, miners, edge_boots, edges CASCADE');

  const blockId = (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state, template_json)
     VALUES ('e', gen_random_uuid(), 'j', '0x1', 100, 'MATURE', '{"compact_target":"0x191b3f4f"}'::jsonb)
     RETURNING id`)).rows[0].id;

  const r = await allocateMatureBlock(db, { blockId, logger: { log: () => {} } });
  assert.strictEqual(r.allocated, false, 'must not allocate without verified income');
  assert.strictEqual(r.reason, 'awaiting-receipt');

  // The block must be left exactly as found. Asserting only the return value
  // is what let the ALLOCATED→revert window survive review: the guard is taken
  // and reverted in two statements outside a transaction, so a crash between
  // them strands the block in ALLOCATED with no allocation and no ledger
  // entries — unrecoverable, because the guard demands MATURE. block-service
  // retries every 15s, so the window is open constantly.
  assert.strictEqual(
    (await db.query(`SELECT state FROM blocks WHERE id = $1`, [blockId])).rows[0].state,
    'MATURE', 'a block awaiting its receipt must still be MATURE afterwards');
});

test('allocation uses the receipt amount, not the block cellbase', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE treasury_receipts, blocks, share_events, ingested_events, sessions, workers, miners, edge_boots, edges CASCADE');

  // the real 2026-08-15 numbers: block cellbase said 829.54, we received 675.06
  const blockId = (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state, reward_shannons, template_json)
     VALUES ('e', gen_random_uuid(), 'j', '0x1', 20160918, 'MATURE', 82954427769,
             '{"compact_target":"0x191b3f4f"}'::jsonb) RETURNING id`)).rows[0].id;
  await db.query(
    `INSERT INTO treasury_receipts
       (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
        lock_args, amount_shannons, mature_at_epoch, confirmed_at)
     VALUES ($1, 20160918, 20160929, $2, 0, '0x5ea0977c3cab6898817c9860fe70d26acf559f76',
             67506476541, 14750, now())`,
    [blockId, '0xb59f2292b05d0736ab819a3be90b24bf6400d3ef9e5253f8c0ad0b9415c63ecb']);

  const reward = await rewardForBlock(db, blockId);
  assert.strictEqual(reward, '67506476541',
    'the pool may only distribute what it actually received');
});

test('a voided receipt (reorged payout) is not allocated', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE treasury_receipts, blocks, share_events, ingested_events, sessions, workers, miners, edge_boots, edges CASCADE');

  const blockId = (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state, reward_shannons, template_json)
     VALUES ('e', gen_random_uuid(), 'j', '0x1', 100, 'MATURE', 82954427769,
             '{"compact_target":"0x191b3f4f"}'::jsonb) RETURNING id`)).rows[0].id;
  await db.query(
    `INSERT INTO treasury_receipts
       (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
        lock_args, amount_shannons, mature_at_epoch, confirmed_at, voided_at)
     VALUES ($1, 100, 111, $2, 0, '0x5ea0977c3cab6898817c9860fe70d26acf559f76',
             67506476541, 14750, now(), now())`,
    [blockId, '0xb59f2292b05d0736ab819a3be90b24bf6400d3ef9e5253f8c0ad0b9415c63ecb']);

  const reward = await rewardForBlock(db, blockId);
  assert.strictEqual(reward, null, 'a voided receipt is not verified income');

  const r = await allocateMatureBlock(db, { blockId, logger: { log: () => {} } });
  assert.strictEqual(r.allocated, false, 'must not allocate on a reorged payment');
  assert.strictEqual(r.reason, 'awaiting-receipt');
  assert.strictEqual(
    (await db.query(`SELECT state FROM blocks WHERE id = $1`, [blockId])).rows[0].state,
    'MATURE', 'a voided payment must leave the block MATURE, not stranded in ALLOCATED');
});
