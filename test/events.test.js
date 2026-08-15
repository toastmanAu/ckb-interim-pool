'use strict';
/**
 * events.test.js — schema validation, spool/WAL durability, publisher
 * ordering/retry semantics for the durable event pipeline (Phase 3).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validate } = require('../src/events/validate.js');
const { createSpool } = require('../src/events/spool.js');
const { createPublisher } = require('../src/events/publisher.js');
const { createEdgeSink } = require('../src/events/edge-sink.js');

const BOOT = 'aabbccdd00112233445566778899eef0';

function shareEvent(overrides = {}) {
  return {
    schema: 'pool.share.accepted.v1',
    event_id: '11111111111111111111111111111111',
    edge_id: 'test-edge-01',
    edge_boot_id: BOOT,
    edge_seq: 1,
    session_id: '22222222222222222222222222222222',
    payout_address: 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v',
    worker: 'k7-01',
    job_id: 'aabbccdd00000001',
    template_work_id: '0x1',
    work_units: '4294967295',
    share_difficulty: '0.9999999997671694',
    share_difficulty_q: '4294967295/4294967296',
    network_difficulty_q: '123456/4294967296',
    pow_hash: 'ab'.repeat(32),
    nonce: '0x' + 'cd'.repeat(16),
    hash: '0x' + 'ef'.repeat(32),
    header_hash_or_header_ref: '0x' + 'ab'.repeat(32),
    accepted_at_ms: 1700000000000,
    is_block_candidate: false,
    ...overrides,
  };
}

// ── schema validation ────────────────────────────────────────────────────────
test('valid share event passes schema', () => {
  assert.deepStrictEqual(validate(shareEvent()), { ok: true });
});

test('schema rejects structural corruptions', () => {
  assert.strictEqual(validate(shareEvent({ schema: "pool.share.accepted.v9" })).ok, false);
  assert.strictEqual(validate(shareEvent({ nonce: '0xzz' })).ok, false, 'nonce hex');
  assert.strictEqual(validate(shareEvent({ work_units: '12.5' })).ok, false, 'work_units integer');
  assert.strictEqual(validate(shareEvent({ work_units: '0x10' })).ok, false);
  assert.strictEqual(validate(shareEvent({ edge_seq: -3 })).ok, false);
  assert.strictEqual(validate(shareEvent({ extra_field: 1 })).ok, false, 'additionalProperties false');
  assert.strictEqual(validate(shareEvent({ is_block_candidate: 'yes' })).ok, false);
  const missing = shareEvent(); delete missing.payout_address;
  assert.strictEqual(validate(missing).ok, false, 'required field');
  assert.strictEqual(validate(null).ok, false);
  assert.strictEqual(validate({}).ok, false);
});

test('schema allows additive community-pool batch fields', () => {
  const v = validate(shareEvent({
    batch_id: 'b-1', batch_seq: 7, operator_pubkey: '0xpub', batch_signature: '0xsig',
  }));
  assert.deepStrictEqual(v, { ok: true });
});

// ── spool (WAL) ──────────────────────────────────────────────────────────────
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pool-spool-')); }

function env(seq) {
  return { seq, event_id: seq.toString(16).padStart(32, '0'), body: shareEvent({ event_id: seq.toString(16).padStart(32, '0'), edge_seq: seq }) };
}

test('spool: append + replay round-trip preserves order and checksums', () => {
  const dir = tmpDir();
  const spool = createSpool({ dir, bootId: BOOT, logger: { log: () => {} } });
  for (let i = 1; i <= 5; i++) spool.append(env(i));
  spool.flushNow();
  const replayed = spool.replay();
  assert.strictEqual(replayed.length, 5);
  assert.deepStrictEqual(replayed.map(r => r.seq), [1, 2, 3, 4, 5]);
  assert.strictEqual(replayed[0].body.event_id, '01'.padStart(32, '0'));
  assert.strictEqual(spool.cursor, 5);
  spool.close();
});

test('spool: survives process restart (re-open same segment, replay + append)', () => {
  const dir = tmpDir();
  const s1 = createSpool({ dir, bootId: BOOT, logger: { log: () => {} } });
  s1.append(env(1)); s1.append(env(2));
  s1.close();
  const s2 = createSpool({ dir, bootId: BOOT, logger: { log: () => {} } });
  const replayed = s2.replay();
  assert.strictEqual(replayed.length, 2);
  s2.append(env(3));
  s2.flushNow();
  assert.strictEqual(createSpool({ dir, bootId: BOOT, logger: { log: () => {} } }).replay().length, 3);
  s2.close();
});

test('spool: corrupted record detected (crc mismatch)', () => {
  const dir = tmpDir();
  const spool = createSpool({ dir, bootId: BOOT, logger: { log: () => {} } });
  spool.append(env(1));
  spool.flushNow();
  const seg = spool.segment;
  spool.close();
  // flip a byte in the JSON body
  const data = fs.readFileSync(seg, 'utf8');
  const corrupted = data.replace('"k7-01"', '"k7-02"');
  fs.writeFileSync(seg, corrupted);
  assert.throws(() => createSpool({ dir, bootId: BOOT, logger: { log: () => {} } }).replay(), /crc mismatch/);
});

test('spool: fails closed at capacity', () => {
  const dir = tmpDir();
  const spool = createSpool({ dir, bootId: BOOT, maxBytes: 256, logger: { log: () => {} } });
  const big = env(1);
  big.body.worker = 'w'.repeat(500);
  assert.throws(() => spool.append(big), /capacity/);
  spool.close();
});

// ── publisher ────────────────────────────────────────────────────────────────
function fakeTransport({ failFirstN = 0 } = {}) {
  let n = 0;
  const published = [];
  return {
    published,
    async publish(subject, event) {
      n++;
      if (n <= failFirstN) throw new Error('bus down');
      published.push({ subject, event });
      return true;
    },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('publisher: publishes in edge-seq order, one at a time', async () => {
  const spool = createSpool({ dir: tmpDir(), bootId: BOOT, logger: { log: () => {} } });
  const t = fakeTransport();
  const p = createPublisher({ spool, transport: t, logger: { log: () => {} }, reconnectMs: 10 });
  for (let i = 1; i <= 4; i++) p.note(env(i));
  await sleep(100);
  assert.deepStrictEqual(t.published.map(x => x.event.edge_seq), [1, 2, 3, 4]);
  assert.deepStrictEqual(t.published.map(x => x.subject), ['pool.v1.edge.test-edge-01.share', 'pool.v1.edge.test-edge-01.share', 'pool.v1.edge.test-edge-01.share', 'pool.v1.edge.test-edge-01.share']);
  spool.close();
});

test('publisher: transport failure → pause, backoff, drain, no event loss', async () => {
  const spool = createSpool({ dir: tmpDir(), bootId: BOOT, logger: { log: () => {} } });
  const t = fakeTransport({ failFirstN: 2 });
  const p = createPublisher({ spool, transport: t, logger: { log: () => {} }, reconnectMs: 20 });
  for (let i = 1; i <= 5; i++) p.note(env(i));
  await sleep(300);
  assert.strictEqual(t.published.length, 5, 'all events eventually published');
  assert.deepStrictEqual(t.published.map(x => x.event.edge_seq), [1, 2, 3, 4, 5], 'order preserved');
  spool.close();
});

test('publisher: invalid events are dropped with a log, not retried forever', async () => {
  const spool = createSpool({ dir: tmpDir(), bootId: BOOT, logger: { log: () => {} } });
  const t = fakeTransport();
  const p = createPublisher({ spool, transport: t, logger: { log: () => {} } });
  p.note({ seq: 99, event_id: 'f'.repeat(32), body: { schema: 'pool.share.accepted.v1', bogus: true } });
  p.note(env(1));
  await sleep(150);
  assert.strictEqual(t.published.length, 1);
  assert.strictEqual(t.published[0].event.edge_seq, 1);
  spool.close();
});

// ── edge sink (spool + publisher + replay) ──────────────────────────────────
test('edge sink: events flow through spool to transport; replay after outage', async () => {
  const dir = tmpDir();
  const t = fakeTransport({ failFirstN: 0 });
  const config = {
    bootId: BOOT,
    spool: { dir, maxBytes: 64 * 1024 * 1024, highWaterBytes: 32 * 1024 * 1024, syncIntervalMs: 50 },
  };
  const sink = createEdgeSink({ config, transport: t, logger: { log: () => {} } });
  await sink.onShareEvent(shareEvent({ event_id: 'a'.repeat(32), edge_seq: 1 }));
  await sink.onBlockEvent({
    schema: 'pool.block.submit.v1',
    event_id: 'b'.repeat(32),
    edge_id: 'test-edge-01',
    edge_boot_id: BOOT,
    edge_seq: 2,
    session_id: '2'.repeat(32),
    payout_address: 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v',
    worker: 'k7-01',
    job_id: 'aabbccdd00000001',
    template_work_id: '0x1',
    nonce: '0x' + '11'.repeat(16),
    height: 100,
    parent_hash: '0x' + '00'.repeat(31) + '01',
    candidate_block_hash: null,
    node_submit_result: 'accepted',
    submit_ok: true,
    submit_latency_ms: 5,
    submitted_at_ms: 1700000000000,
    work_units: '4294967295',
    header: {
      version: '0x0', compact_target: '0x191b3f4f', current_time: '0x1e1e1e1e',
      number: '0x64', epoch: '0x0', parent_hash: '0x' + '00'.repeat(31) + '01',
      transactions_root: '0x' + '11'.repeat(32), proposals_hash: '0x' + '22'.repeat(32),
      extra_hash: '0x' + '33'.repeat(32), dao: '0x' + '44'.repeat(32),
      nonce: '0x' + '11'.repeat(16),
    },
  });
  await sleep(150);
  const t0p = Date.now();
  while (t.published.length < 2 && Date.now() - t0p < 5000) await sleep(25);
  assert.deepStrictEqual(t.published.map(x => x.event.edge_seq), [1, 2]);
  // block event goes to its own subject
  assert.ok(t.published.some(x => x.subject === 'pool.v1.edge.test-edge-01.block_submit'));

  // simulate a crash: new sink on same spool dir + same transport → replay
  const sink2 = createEdgeSink({ config, transport: t, logger: { log: () => {} } });
  await sink2.replay();
  await sleep(150);
  const all = t.published.map(x => x.event.event_id);
  assert.strictEqual(all.filter(id => id === 'a'.repeat(32)).length, 2, 'replayed exactly once after restart');
  sink2.close();
});

// A block the node REJECTS is the event most worth keeping, and it is the one
// carrying an unbounded error string. On 2026-08-14 a real rejected submission
// (height 20142765, a ~330-char CKB InvalidNonce message) failed validation
// against maxLength 256 and was dropped as invalid — the rejection left no
// trace in accounting at all. The producer must clamp to the schema bound.
test('a verbose node rejection still produces a schema-valid block-submit event', () => {
  const ckbInvalidNonce =
    'rejected:{"code":-3,"message":"Invalid: Header(Pow(InvalidNonce: please set ' +
    'logger.filter to \\"info,ckb-pow=debug\\" for detailed PoW verification ' +
    'information))","data":"Error { kind: Header, inner: Pow(InvalidNonce: please ' +
    'set logger.filter to \\"info,ckb-pow=debug\\" for detailed PoW verification ' +
    'information) }"}';
  assert.ok(ckbInvalidNonce.length > 256, 'fixture must exceed the old bound to be meaningful');

  const evt = {
    schema: 'pool.block.submit.v1',
    event_id: 'c'.repeat(32),
    edge_id: 'test-edge-01',
    edge_boot_id: BOOT,
    edge_seq: 3,
    session_id: '2'.repeat(32),
    payout_address: 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v',
    worker: 'k7-01',
    job_id: 'aabbccdd00000001',
    template_work_id: '0x1',
    nonce: '0x' + '11'.repeat(16),
    height: 100,
    parent_hash: '0x' + '00'.repeat(31) + '01',
    candidate_block_hash: null,
    node_submit_result: ckbInvalidNonce,
    submit_ok: false,
    submit_latency_ms: 5,
    submitted_at_ms: 1700000000000,
    work_units: '4294967295',
    header: {
      version: '0x0', compact_target: '0x191b3f4f', current_time: '0x1e1e1e1e',
      number: '0x64', epoch: '0x0', parent_hash: '0x' + '00'.repeat(31) + '01',
      transactions_root: '0x' + '11'.repeat(32), proposals_hash: '0x' + '22'.repeat(32),
      extra_hash: '0x' + '33'.repeat(32), dao: '0x' + '44'.repeat(32),
      nonce: '0x' + '11'.repeat(16),
    },
  };

  const v = validate(evt);
  assert.ok(v.ok, `real CKB rejection must validate, got: ${JSON.stringify(v.errors)}`);
});

test('edge sink: sink throws on spool failure so the edge can fail closed', async () => {
  const dir = tmpDir();
  const config = {
    bootId: BOOT,
    spool: { dir, maxBytes: 2048, highWaterBytes: 1024, syncIntervalMs: 50 },
  };
  const sink = createEdgeSink({ config, transport: fakeTransport(), logger: { log: () => {} } });
  const big = shareEvent({ worker: 'x'.repeat(2000) });
  await assert.rejects(() => sink.onShareEvent(big), /capacity/);
  sink.close();
});
