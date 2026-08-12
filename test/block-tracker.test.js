'use strict';
/**
 * block-tracker.test.js — block lifecycle: canonicality, orphan, reward
 * extraction, maturity. Uses a mock trusted node serving a synthetic chain.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { createDb } = require('../src/accounting/db.js');
const { processEvent } = require('../src/accounting/ingest.js');
const { createBlockTracker, candidateBlockHash } = require('../src/accounting/block-tracker.js');
const { ckbBlake2b } = require('../src/mining/blake2b.js');
const { serializeFullHeader } = require('../src/mining/ckb-header.js');
const { uuidv7 } = require('../src/common/ids.js');

const DB_URL = process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest';
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try {
  execSync(`docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1`);
  dbReady = true;
} catch { dbReady = false; }

const EDGE = 'test-edge-01';
const BOOT = 'aabbccdd00112233445566778899eef0';
const ADDR = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';

function headerFields(over = {}) {
  return {
    version: '0x0',
    compact_target: '0x191b3f4f',
    current_time: '0x1e1e1e1e',
    number: '0x1e240',
    epoch: over.epoch || '0x100000000',
    parent_hash: '0x' + '00'.repeat(31) + '01',
    transactions_root: '0x' + '11'.repeat(32),
    proposals_hash: '0x' + '22'.repeat(32),
    extra_hash: '0x' + '33'.repeat(32),
    dao: '0x' + '44'.repeat(32),
    ...over,
  };
}

const HDR = headerFields();
const NONCE = '0x' + 'ab'.repeat(16);
const BLOCK_HASH = ckbBlake2b(serializeFullHeader({ ...HDR, timestamp: HDR.current_time }, NONCE)).toString('hex');

function makeChainServer({ canonicalHash, rewardShannons, tipNumber = '0x1e240', tipEpoch = '0x100000000' }) {
  const handlers = {
    get_tip_header: () => ({ number: tipNumber, epoch: tipEpoch, hash: '0x' + canonicalHash }),
    get_block_by_number: () => ({
      header: { hash: '0x' + canonicalHash, epoch: HDR.epoch },
      transactions: [
        { outputs: [{ capacity: `0x${(rewardShannons / 2n).toString(16)}` }, { capacity: `0x${(rewardShannons - rewardShannons / 2n).toString(16)}` }] },
      ],
    }),
  };
  const state = {};
  const api = {
    async rpc(method, params) {
      if (method === 'get_tip_header') return handlers.get_tip_header();
      if (method === 'get_block_by_number') return handlers.get_block_by_number();
      throw new Error('unexpected rpc ' + method);
    },
    setCanonicalHash(h) { state.canonicalHash = h; },
    setTip(h) { state.tipNumber = h; },
    handlers,
  };
  // route via state setters
  handlers.get_tip_header = () => ({ number: state.tipNumber || tipNumber, epoch: state.tipEpoch || tipEpoch, hash: '0x' + (state.canonicalHash || canonicalHash) });
  handlers.get_block_by_number = () => ({
    header: { hash: '0x' + (state.canonicalHash || canonicalHash), epoch: HDR.epoch },
    transactions: [
      { outputs: [{ capacity: `0x${(rewardShannons / 2n).toString(16)}` }, { capacity: `0x${(rewardShannons - rewardShannons / 2n).toString(16)}` }] },
    ],
  });
  return api;
}

function shareEvent(seq, { block = false, nonce = NONCE } = {}) {
  return {
    schema: 'pool.share.accepted.v1',
    event_id: uuidv7(),
    edge_id: EDGE,
    edge_boot_id: BOOT,
    edge_seq: seq,
    session_id: '22222222222222222222222222222222',
    payout_address: ADDR,
    worker: 'k7-01',
    job_id: `aabbccdd${seq.toString(16).padStart(8, '0')}`,
    template_work_id: '0x1',
    work_units: '4294967296',
    share_difficulty: '1',
    share_difficulty_q: '4294967296/4294967296',
    network_difficulty_q: '1/4294967296',
    pow_hash: 'ab'.repeat(32),
    nonce,
    hash: '0x' + 'ef'.repeat(32),
    header_hash_or_header_ref: '0x' + 'ab'.repeat(32),
    accepted_at_ms: 1700000000000 + seq,
    is_block_candidate: block,
  };
}

function blockSubmitEvent(seq, shareEvt) {
  return {
    schema: 'pool.block.submit.v1',
    event_id: uuidv7(),
    edge_id: EDGE,
    edge_boot_id: BOOT,
    edge_seq: seq,
    session_id: shareEvt.session_id,
    payout_address: shareEvt.payout_address,
    worker: shareEvt.worker,
    job_id: shareEvt.job_id,
    template_work_id: shareEvt.template_work_id,
    nonce: shareEvt.nonce,
    height: parseInt(HDR.number, 16),
    parent_hash: HDR.parent_hash,
    candidate_block_hash: null,
    node_submit_result: 'accepted',
    submit_ok: true,
    submit_latency_ms: 5,
    submitted_at_ms: shareEvt.accepted_at_ms + 10,
    work_units: shareEvt.work_units,
    header: { ...HDR, nonce: shareEvt.nonce },
  };
}

test('block lifecycle: canonical → immature → mature; orphan detection', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE blocks, share_events, ingested_events, sessions, workers, miners, edge_boots, edges CASCADE');

  const reward = 110000000000n;   // 1100 CKB
  const node = makeChainServer({ canonicalHash: BLOCK_HASH, rewardShannons: reward });
  const tracker = createBlockTracker({ db, rpcClient: node, logger: { log: () => {} } });

  const sWin = shareEvent(1, { block: true });
  const bWin = blockSubmitEvent(2, sWin);
  await processEvent(db, sWin);
  await processEvent(db, bWin);

  // ── canonical but immature ───────────────────────────────────────────────
  await tracker.tick();
  let row = (await db.query(`SELECT state, reward_shannons, block_hash FROM blocks WHERE nonce = $1`, [NONCE])).rows[0];
  assert.strictEqual(row.state, 'CANONICAL_IMMATURE');
  assert.strictEqual(row.block_hash, '0x' + BLOCK_HASH);
  assert.strictEqual(row.reward_shannons, reward.toString(), 'reward from chain cellbase');

  // ── mature after 4 epochs ─────────────────────────────────────────────────
  // epoch encoding: 0x{length[16]}{index[16]}{number[24]} — number is LOW bits
  const epochHex = (number) => '0x' + BigInt(number).toString(16);
  node.handlers.get_tip_header = () => ({ number: '0x1e240', epoch: epochHex(5), hash: '0x' + BLOCK_HASH });
  await tracker.tick();
  row = (await db.query(`SELECT state, matured_at FROM blocks WHERE nonce = $1`, [NONCE])).rows[0];
  assert.strictEqual(row.state, 'MATURE');
  assert.ok(row.matured_at);

  // ── orphan: node tip advanced past height with a different block ─────────
  await db.query('TRUNCATE blocks CASCADE');
  await processEvent(db, shareEvent(10, { block: true, nonce: '0x' + 'cd'.repeat(16) }));
  await processEvent(db, { ...blockSubmitEvent(11, shareEvent(10, { block: true, nonce: '0x' + 'cd'.repeat(16) })), nonce: '0x' + 'cd'.repeat(16), height: parseInt(HDR.number, 16) });
  node.handlers.get_block_by_number = () => ({
    header: { hash: '0x' + 'ff'.repeat(32), epoch: HDR.epoch },
    transactions: [{ outputs: [{ capacity: '0x1' }] }],
  });
  await tracker.tick();
  row = (await db.query(`SELECT state FROM blocks WHERE nonce = $1`, ['0x' + 'cd'.repeat(16)])).rows[0];
  assert.strictEqual(row.state, 'ORPHANED', 'different block at height → orphaned');

  // ── candidateBlockHash is pure and matches the fixture-proven formula ────
  assert.strictEqual(candidateBlockHash(HDR, NONCE), BLOCK_HASH);
});
