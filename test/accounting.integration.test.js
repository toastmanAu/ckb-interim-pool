'use strict';
/**
 * accounting.integration.test.js — Phase 4 gate: PostgreSQL ingestion.
 *
 * Requires docker containers:
 *   deploy/pg-test.sh   (postgres on :5433)
 *   deploy/nats-test.sh (nats on :4223)
 *
 * Gate: replay the full event stream twice; row counts and monetary state
 * remain unchanged. Idempotency is enforced by ingested_events + unique
 * constraints. Skips when PostgreSQL is unreachable.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const { connect, StringCodec } = require('nats');

const { createDb } = require('../src/accounting/db.js');
const { processEvent } = require('../src/accounting/ingest.js');
const { createNatsTransport } = require('../src/events/nats-transport.js');
const { uuidv7 } = require('../src/common/ids.js');

const DB_URL = process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest';
const NATS_URL = process.env.POOL_NATS_URL || 'nats://127.0.0.1:4223';
const STREAM = 'POOL_V1_ACCT_TEST';
const MIGRATIONS = require('node:path').join(__dirname, '..', 'db', 'migrations');

const ADDR = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const ADDR2 = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4';
const BOOT = 'aabbccdd00112233445566778899eef0';
const EDGE = 'test-edge-01';

let dbReady = false;
try {
  execSync(`PGPASSWORD=pooltest psql -h 127.0.0.1 -p 5433 -U pool -d pooltest -c 'SELECT 1' >/dev/null 2>&1 || docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1`);
  dbReady = true;
} catch { dbReady = false; }

const sc = StringCodec();

function shareEvent(seq, { worker = 'k7-01', address = ADDR, block = false, atMs = 1700000000000 + seq } = {}) {
  return {
    schema: 'pool.share.accepted.v1',
    event_id: uuidv7(),
    edge_id: EDGE,
    edge_boot_id: BOOT,
    edge_seq: seq,
    session_id: '22222222222222222222222222222222',
    payout_address: address,
    worker,
    job_id: `aabbccdd${seq.toString(16).padStart(8, '0')}`,
    template_work_id: '0x1',
    work_units: String(4294967296n * BigInt(seq)),
    share_difficulty: '1',
    share_difficulty_q: `${4294967296n * BigInt(seq)}/4294967296`,
    network_difficulty_q: '123456/4294967296',
    pow_hash: 'ab'.repeat(32),
    nonce: '0x' + seq.toString(16).padStart(32, '0'),
    hash: '0x' + 'ef'.repeat(32),
    header_hash_or_header_ref: '0x' + 'ab'.repeat(32),
    accepted_at_ms: atMs,
    is_block_candidate: block,
  };
}

function blockEvent(seq, shareEvt, { ok = true } = {}) {
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
    height: 123456,
    parent_hash: '0x' + '00'.repeat(31) + '01',
    candidate_block_hash: null,
    node_submit_result: ok ? 'accepted' : 'rejected:invalid',
    submit_ok: ok,
    submit_latency_ms: 7,
    submitted_at_ms: shareEvt.accepted_at_ms + 50,
    work_units: shareEvt.work_units,
  };
}

async function counts(db) {
  const q = async (sql, p) => (await db.query(sql, p)).rows[0];
  return {
    miners: (await q('SELECT count(*)::int c FROM miners')).c,
    workers: (await q('SELECT count(*)::int c FROM workers')).c,
    shares: (await q('SELECT count(*)::int c FROM share_events')).c,
    blocks: (await q('SELECT count(*)::int c FROM blocks')).c,
    ingested: (await q('SELECT count(*)::int c FROM ingested_events')).c,
    work: (await q('SELECT COALESCE(sum(work_units),0)::text w FROM share_events')).w,
  };
}

test('ingestion: idempotent replay + nats pipeline', { timeout: 90000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  // clean slate
  await db.query('TRUNCATE ingested_events, share_events, blocks, sessions, workers, miners, edge_boots, edges CASCADE');

  const s1 = shareEvent(1, { address: ADDR, worker: 'k7-01' });
  const s2 = shareEvent(2, { address: ADDR, worker: 'k7-02' });
  const s3 = shareEvent(3, { address: ADDR2, worker: 'gs-1' });
  const sWin = shareEvent(4, { address: ADDR, worker: 'k7-01', block: true });
  const bWin = blockEvent(5, sWin);
  const bRej = blockEvent(6, s1, { ok: false });

  // ── direct processing + double-apply (idempotency gate) ─────────────────
  for (const evt of [s1, s2, s3, sWin, bWin, bRej]) {
    const r1 = await processEvent(db, evt);
    assert.strictEqual(r1.status, 'applied');
    const r2 = await processEvent(db, evt);
    assert.strictEqual(r2.status, 'duplicate', 'replay is a no-op');
  }
  // re-apply with a DIFFERENT event_id but same (edge_id, boot_id, edge_seq)
  const s1dup = { ...s1, event_id: uuidv7() };
  assert.strictEqual((await processEvent(db, s1dup)).status, 'duplicate');

  let c = await counts(db);
  assert.strictEqual(c.miners, 2);
  assert.strictEqual(c.workers, 3);
  assert.strictEqual(c.shares, 4, 'all 4 accepted shares (incl. block candidate)');
  assert.strictEqual(c.blocks, 2, 'accepted + rejected submissions tracked');
  assert.strictEqual(c.ingested, 6);
  const win = (await db.query(`SELECT state, candidate_event_id FROM blocks WHERE nonce = $1`, [sWin.nonce])).rows[0];
  assert.strictEqual(win.state, 'NODE_ACCEPTED');
  assert.strictEqual(win.candidate_event_id.replace(/-/g, ''), sWin.event_id, 'candidate share linked');
  const rej = (await db.query(`SELECT state FROM blocks WHERE nonce = $1`, [s1.nonce])).rows[0];
  assert.strictEqual(rej.state, 'NODE_REJECTED');

  // invalid event → no writes, no crash
  const bad = { ...s2, schema: 'pool.share.accepted.v1', work_units: 'abc' };
  assert.strictEqual((await processEvent(db, bad)).status, 'invalid');
  c = await counts(db);
  assert.strictEqual(c.shares, 4, 'invalid events do not write');

  // ── nats pipeline: same events via JetStream, replay stream twice ───────
  {
    const nc0 = await connect({ servers: NATS_URL, timeout: 3000 });
    const jsm0 = await nc0.jetstreamManager();
    try { await jsm0.streams.delete(STREAM); } catch {}
    await nc0.close();

    const transport = await createNatsTransport({
      servers: [NATS_URL], stream: STREAM, subjects: ['pool.v1.accttest.>'], logger: { log: () => {} },
    }).start();
    for (const evt of [s1, s2, s3, sWin, bWin, bRej]) {
      await transport.publish(`pool.v1.accttest.${EDGE}.share`, evt);
    }
    await transport.close();

    // pull the events back through processEvent (simulating the consumer
    // without a second process) — twice
    const nc = await connect({ servers: NATS_URL, timeout: 3000 });
    const jsm = await nc.jetstreamManager();
    const info = await jsm.streams.info(STREAM);
    for (let pass = 0; pass < 2; pass++) {
      for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq++) {
        const m = await jsm.streams.getMessage(STREAM, { seq });
        const evt = JSON.parse(sc.decode(m.data));
        const r = await processEvent(db, evt);
        assert.ok(r.status === 'duplicate' || r.status === 'applied');
      }
    }
    await nc.close();
  }

  const c2 = await counts(db);
  assert.deepStrictEqual(c2, c, 'row counts and work unchanged after stream replay x2');
  assert.strictEqual(c2.work, String(4294967296n * 10n), 'work summed exactly (no float)');
});
