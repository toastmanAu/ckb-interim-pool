'use strict';
/**
 * edge.integration.test.js — pool-edge end-to-end over real TCP:
 * fake K7/GodMiner + Goldshell miners, mock CKB node, in-memory sink.
 *
 * Vectors (deterministic, mined offline with test/tools/mine-share.js):
 *   SHARE  powHash=3b9780… nonce=0x…26de meets local target(1e-6), not network
 *   REJECT nonce=0x…0001   meets neither
 *   BLOCK  powHash=c9d1e8… nonce=0x…3b  meets easy network target (0x1fffffff)
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockNode } = require('./tools/mock-node.js');
const { createEdge } = require('../src/edge/edge.js');
const { loadConfig } = require('../src/common/config.js');
const { createMemorySink } = require('../src/events/memory-sink.js');
const merkle = require('../src/mining/ckb-merkle.js');
const { computePowHash } = require('../src/mining/ckb-header.js');
const { diffToTargetLE, meetsTargetLE } = require('../src/mining/ckb-target.js');
const { eaglesong } = require('../src/mining/eaglesong.js');
const { leToBe } = require('../src/stratum/miner-family.js');

const fixture = require('./fixtures/mainnet-multitx-5.json');

const ADDR = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';   // RFC 0021 short (mainnet)

function asTemplate(block, { compactTarget, parentHash, number, workId }) {
  const h = block.header;
  return {
    version: h.version,
    compact_target: compactTarget || h.compact_target,
    current_time: h.timestamp,
    number: number || h.number,
    epoch: h.epoch,
    parent_hash: parentHash || h.parent_hash,
    dao: h.dao,
    work_id: workId || '0x1',
    cellbase: { hash: block.transactions[0].hash, data: block.transactions[0] },
    transactions: block.transactions.slice(1).map(tx => ({ hash: tx.hash, data: tx })),
    proposals: block.proposals,
    uncles: block.uncles.map(u => ({ hash: u.header.hash, header: u.header, proposals: u.proposals })),
    extension: block.extension,
  };
}

const TPL_A = asTemplate(fixture, { workId: '0x1' });
const TPL_B = asTemplate(fixture, {
  compactTarget: '0x1fffffff',                                    // easy network target
  parentHash: '0x' + '00'.repeat(31) + '01',
  number: '0x' + (parseInt(fixture.header.number, 16) + 1).toString(16),
  workId: '0x2',
});

const POW_A = computePowHash(merkle.templateToHeaderFields(TPL_A));
const POW_B = computePowHash(merkle.templateToHeaderFields(TPL_B));
const TARGET_A = diffToTargetLE(1e-6);                            // session share target at diff 1e-6

// ── helpers ──────────────────────────────────────────────────────────────────
function writeTestConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-edge-test-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    edge: {
      id: 'test-edge-01', region: 'test', stratumHost: '127.0.0.1', stratumPort: 0,
      statsHost: '127.0.0.1', statsPort: 0, network: 'ckb',
      // fixed boot id → deterministic per-session extranonce1 for session 1:
      // bootId.slice(0,8) + '00000001' = 'aabbccdd00000001' (share vectors
      // below were mined against this exact prefix)
      bootId: 'aabbccdd00112233445566778899eef0',
    },
    node: { host: '127.0.0.1', port: 0, wsPort: 0, pollMs: 50, timeoutMs: 2000 },
    vardiff: {
      targetShareSec: 30, retargetSec: 60, variancePercent: 30,
      minDiff: 1e-6, maxDiff: 1e9, initialDiff: 1e-6, godminerInitialDiff: 1e-6,
    },
    limits: { maxConnectionsPerIp: 64, maxConnectionsTotal: 1024, idleTimeoutMs: 30000, maxLineBytes: 65536, jsonErrorBudget: 10, maxAuthAttempts: 20 },
    ...overrides,
  }));
  return cfgPath;
}

function fakeMiner(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const messages = [];
    let buf = '';
    const msgWaiters = [];
    sock.setEncoding('utf8');
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        messages.push(msg);
        for (let w = msgWaiters.length - 1; w >= 0; w--) {
          if (msgWaiters[w].pred(msg)) { msgWaiters[w].resolve(msg); msgWaiters.splice(w, 1); }
        }
      }
    });
    sock.on("connect", () => {
      resolve({
        sock,
        messages,
        send: o => sock.write(JSON.stringify(o) + '\n'),
        lastNotify: () => [...messages].reverse().find(m => m.method === 'mining.notify'),
        lastSetTarget: () => [...messages].reverse().find(m => m.method === 'mining.set_target'),
        waitFor(pred, timeoutMs = 8000) {
          const hit = messages.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const w = { pred, resolve: res };
            msgWaiters.push(w);
            setTimeout(() => {
              const i = msgWaiters.indexOf(w);
              if (i !== -1) msgWaiters.splice(i, 1);
              rej(new Error('timeout waiting for message'));
            }, timeoutMs);
          });
        },
      });
    });
  });
}

async function startTestEdge(t, { configOverrides = {}, sink } = {}) {
  const cfgPath = writeTestConfig(configOverrides);
  const cfg = loadConfig(cfgPath);
  const node = await createMockNode({ templates: [TPL_A, TPL_B] }).listen();
  t.after(() => { try { node.close(); } catch {} });
  cfg.node.port = node.port;
  cfg.node.wsPort = node.wsPort;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const edge = createEdge({ configPath: cfgPath, sink: sink || createMemorySink(), logger: { log: () => {} } });
  edge.start();
  t.after(() => { try { edge.stop(); } catch {} });
  await Promise.all([
    new Promise(r => edge.edgeServer.stratumServer.once('listening', r)),
    new Promise(r => edge.edgeServer.statsServer.once('listening', r)),
  ]);
  const stratumPort = edge.edgeServer.stratumServer.address().port;
  return { edge, node, cfg, cfgPath, stratumPort };
}

// ── tests ────────────────────────────────────────────────────────────────────
test('K7 miner: subscribe wire shape + unique extranonce1 per session', async t => {
  const { stratumPort } = await startTestEdge(t);
  const m1 = await fakeMiner(stratumPort);
  const m2 = await fakeMiner(stratumPort);

  m1.send({ id: 1, method: 'mining.subscribe', params: ['ckbminer-v1.0.0'] });
  m2.send({ id: 2, method: 'mining.subscribe', params: ['GodMiner v0.4.7'] });

  const r1 = await m1.waitFor(m => m.id === 1);
  const r2 = await m2.waitFor(m => m.id === 2);

  assert.deepStrictEqual(r1.result, [null, r1.result[1], 8], 'K7 3-tuple [null, en1, 8]');
  assert.deepStrictEqual(r2.result, [null, r2.result[1], 8]);
  assert.strictEqual(r1.result[1].length, 16, 'extranonce1 = 8 bytes hex');
  assert.notStrictEqual(r1.result[1], r2.result[1], 'per-session extranonce1 uniqueness');
});

test('K7 miner: authorize + accepted share + duplicate + low-diff + unknown job', async t => {
  const sink = createMemorySink();
  const { edge, stratumPort } = await startTestEdge(t, { sink });

  const m = await fakeMiner(stratumPort);
  m.send({ id: 1, method: 'mining.subscribe', params: ['ckbminer-v1.0.0'] });
  const sub = await m.waitFor(m => m.id === 1);
  const en1 = sub.result[1];

  // bad address rejected at authorize
  m.send({ id: 2, method: 'mining.authorize', params: ['ckb1qyqinvalid.address'] });
  const bad = await m.waitFor(m => m.id === 2);
  assert.strictEqual(bad.result, false);
  assert.strictEqual(bad.error[0], 24);

  // good address
  m.send({ id: 3, method: 'mining.authorize', params: [`${ADDR}.k7-01`] });
  const auth = await m.waitFor(m => m.id === 3);
  assert.strictEqual(auth.result, true);

  // job arrives at/after authorize (template may not be ready at subscribe)
  const notify = await m.waitFor(m => m.method === 'mining.notify');
  const jobId = notify.params[0];

  // notify target must be BE-encoded for K7
  assert.strictEqual(notify.params[3], leToBe('000000000000000000000000000000000000000000004f3f1b00000000000000'));

  // accepted share (mined vector: full nonce = en1 + n8, en1='aabbccdd00000001')
  m.send({ id: 4, method: 'mining.submit', params: ['x', jobId, '0x0000000000000704'] });
  const acc = await m.waitFor(m => m.id === 4);
  assert.strictEqual(acc.result, true);
  assert.strictEqual(acc.error, null);

  // duplicate → error 22
  m.send({ id: 5, method: 'mining.submit', params: ['x', jobId, '0x0000000000000704'] });
  const dup = await m.waitFor(m => m.id === 5);
  assert.strictEqual(dup.result, false);
  assert.strictEqual(dup.error[0], 22);

  // low-diff share → error 23
  m.send({ id: 6, method: 'mining.submit', params: ['x', jobId, '0x00000000000000000000000000000001'] });
  const low = await m.waitFor(m => m.id === 6);
  assert.strictEqual(low.result, false);
  assert.strictEqual(low.error[0], 23);

  // unknown job → acked (proven upstream behavior), no event
  m.send({ id: 7, method: 'mining.submit', params: ['x', '99999999', '0x0000000000000704'] });
  const unk = await m.waitFor(m => m.id === 7);
  assert.strictEqual(unk.result, true);

  // share event assertions
  assert.strictEqual(sink.events.length, 1);
  const evt = sink.events[0];
  assert.strictEqual(evt.schema, 'pool.share.accepted.v1');
  assert.strictEqual(evt.edge_id, 'test-edge-01');
  assert.strictEqual(evt.payout_address, ADDR);
  assert.strictEqual(evt.worker, 'k7-01');
  assert.strictEqual(evt.job_id, jobId);
  assert.strictEqual(evt.template_work_id, '0x1');
  assert.strictEqual(evt.is_block_candidate, false);
  assert.strictEqual(evt.nonce, '0x' + en1 + '0000000000000704', 'full K7 nonce = en1 || miner nonce');
  assert.ok(BigInt(evt.work_units) > 0n, 'integer work units present');
  assert.ok(/^\d+$/.test(evt.work_units), 'work_units is an integer string');
  assert.ok(/^\d+\/\d+$/.test(evt.share_difficulty_q), 'canonical q form');
  // full nonce reconstructs the mined hash
  const fullNonce = en1 + '0000000000000704';
  const hash = eaglesong(Buffer.concat([Buffer.from(POW_A, 'hex'), Buffer.from(fullNonce, 'hex')]));
  assert.strictEqual('0x' + hash.toString('hex'), evt.hash);
  assert.strictEqual(evt.hash, '0x000324bc214eb593c8f5c932b4aa711d880fc427636a6e106c02b9fcd4531b99');
  assert.strictEqual(evt.pow_hash, POW_A);
});

test('Goldshell miner: nested subscribe + 5-field submit accepted', async t => {
  const sink = createMemorySink();
  const { stratumPort } = await startTestEdge(t, { sink });

  const m = await fakeMiner(stratumPort);
  m.send({ id: 1, method: 'mining.subscribe', params: ['intminer/1.0.0', 'aabbccdd'] });
  const sub = await m.waitFor(m => m.id === 1);
  assert.deepStrictEqual(sub.result, [
    [['mining.set_difficulty', 'aabbccdd'], ['mining.notify', 'aabbccdd']],
    'aabbccdd',
    4,
  ], 'session id passed through (session-resume)');

  m.send({ id: 2, method: 'mining.authorize', params: [`${ADDR}.gs-1`] });
  const auth = await m.waitFor(m => m.id === 2);
  assert.strictEqual(auth.result, true);

  const notify = await m.waitFor(m => m.method === 'mining.notify');
  assert.strictEqual(notify.params[3], '000000000000000000000000000000000000000000004f3f1b00000000000000', 'LE target for non-K7');
  const jobId = notify.params[0];

  // 5-field submit; nonce zero-padded to 16 bytes (no extranonce prefix)
  m.send({ id: 3, method: 'mining.submit', params: ['x', jobId, '00000000', '0', '0x26de'] });
  const acc = await m.waitFor(m => m.id === 3);
  assert.strictEqual(acc.result, true);
  assert.strictEqual(sink.events.length, 1);
  assert.strictEqual(sink.events[0].nonce, '0x' + '000000000000000000000000000026de');
  assert.strictEqual(sink.events[0].worker, 'gs-1');
});

test('block discovery: immediate local submission + clean notify + block event', async t => {
  const sink = createMemorySink();
  const { edge, node, stratumPort } = await startTestEdge(t, { sink });

  const m = await fakeMiner(stratumPort);
  m.send({ id: 1, method: 'mining.subscribe', params: ['ckbminer-v1.0.0'] });
  const sub = await m.waitFor(m => m.id === 1);
  const en1 = sub.result[1];

  m.send({ id: 2, method: 'mining.authorize', params: [ADDR] });
  await m.waitFor(m => m.id === 2);

  // job arrives with/after authorize (template fetch may still be in flight at subscribe)
  const n1 = await m.waitFor(m => m.method === 'mining.notify');
  const jobA = n1.params[0];

  // rotate to the easy-target template via WS new-tip push
  node.pushNewTip();
  const n2 = await m.waitFor(m => m.method === 'mining.notify' && m.params[0] !== jobA);
  assert.strictEqual(n2.params[4], true, 'clean_jobs=true on parent change (new tip)');
  const jobB = n2.params[0];
  assert.strictEqual(n2.params[3], leToBe('00000000000000000000000000000000000000000000000000000000ffffff00'), 'BE easy target on wire');

  // block nonce solved against template B (full nonce = en1 + '...009b')
  m.send({ id: 3, method: 'mining.submit', params: ['x', jobB, '0x000000000000009b'] });
  const acc = await m.waitFor(m => m.id === 3);
  assert.strictEqual(acc.result, true);

  // block submitted to the LOCAL node immediately (critical path) — submission
  // is async after the miner ack, so poll for it
  const t0 = Date.now();
  while (node.submitted.length === 0 && Date.now() - t0 < 5000) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.strictEqual(node.submitted.length, 1);
  const s = node.submitted[0];
  assert.strictEqual(s.workId, '0x2');
  // the node reads the nonce as a u128 value serialized LE — the submitted
  // hex is the byte-reversed raw nonce (live-node finding, 2026-08-13)
  const rawNonce = en1 + '000000000000009b';
  const reversed = rawNonce.match(/.{2}/g).reverse().join('');
  assert.strictEqual(s.block.header.nonce, '0x' + reversed);
  assert.strictEqual(parseInt(s.block.header.number, 16), parseInt(fixture.header.number, 16) + 1);

  // miner gets clean=true notify after a find
  const post = await m.waitFor(m => m.method === 'mining.notify' && m.params[4] === true);
  assert.ok(post);

  // block event published with submit result
  const bevt = sink.events.find(e => e.schema === 'pool.block.submit.v1');
  assert.ok(bevt, 'block submit event present');
  assert.strictEqual(bevt.submit_ok, true);
  assert.strictEqual(bevt.height, parseInt(fixture.header.number, 16) + 1);
  assert.strictEqual(bevt.nonce, '0x' + en1 + '000000000000009b');
  assert.strictEqual(bevt.template_work_id, '0x2');
  // share event for the winning share also present, flagged as block candidate
  const shareEvt = sink.events.find(e => e.schema === 'pool.share.accepted.v1' && e.is_block_candidate);
  assert.ok(shareEvt, 'winning share event flagged is_block_candidate');
  assert.strictEqual(shareEvt.pow_hash, POW_B);
  assert.strictEqual(bevt.nonce, shareEvt.nonce, 'block event correlates to winning share');
});

test('stale share (previous tip) is ACKed but not credited', async t => {
  const sink = createMemorySink();
  const { edge, node, stratumPort } = await startTestEdge(t, { sink });

  const m = await fakeMiner(stratumPort);
  m.send({ id: 1, method: 'mining.subscribe', params: ['ckbminer-v1.0.0'] });
  const sub = await m.waitFor(m => m.id === 1);
  m.send({ id: 2, method: 'mining.authorize', params: [ADDR] });
  await m.waitFor(m => m.id === 2);

  const n1 = await m.waitFor(m => m.method === 'mining.notify');
  const jobA = n1.params[0];

  // rotate to template B
  node.pushNewTip();
  await m.waitFor(m => m.method === 'mining.notify' && m.params[0] !== jobA);

  // submit a valid share against the OLD job → acked (upstream leniency), not credited
  m.send({ id: 3, method: 'mining.submit', params: ['x', jobA, '0x0000000000000704'] });
  const res = await m.waitFor(m => m.id === 3);
  assert.strictEqual(res.result, true, 'stale share acked');
  assert.strictEqual(sink.events.length, 0, 'no credit event for stale share');
  assert.ok(edge.edgeServer.totals.staleAcked >= 1, 'stale counter incremented');
});

test('suggest_difficulty honored with wire messages', async t => {
  const { stratumPort } = await startTestEdge(t, {});
  const m = await fakeMiner(stratumPort);
  m.send({ id: 1, method: 'mining.subscribe', params: ['intminer/1.0.0'] });
  await m.waitFor(m => m.id === 1);
  m.send({ id: 2, method: 'mining.authorize', params: [ADDR] });
  await m.waitFor(m => m.id === 2);

  m.send({ id: 3, method: 'mining.suggest_difficulty', params: [5000] });
  const ack = await m.waitFor(m => m.id === 3);
  assert.strictEqual(ack.result, true);
  const st = await m.waitFor(m => m.method === 'mining.set_target');
  assert.ok(st, 'set_target sent');
  const sd = [...m.messages].reverse().find(x => x.method === 'mining.set_difficulty');
  assert.ok(sd, 'set_difficulty sent for non-K7');
  assert.strictEqual(sd.params[0], 5000);
});

test('health + metrics endpoints', async t => {
  const { edge, stratumPort } = await startTestEdge(t, {});
  const port = edge.edgeServer.statsServer.address().port;
  // wait for the first template fetch (edge boot race)
  let health;
  const t0 = Date.now();
  do {
    await new Promise(r => setTimeout(r, 25));
    health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
  } while (!health.has_template && Date.now() - t0 < 5000);
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.edge_id, 'test-edge-01');
  assert.ok(health.boot_id.length === 32, 'boot id is uuid');
  assert.strictEqual(health.has_template, true);
  const metricsText = await fetch(`http://127.0.0.1:${port}/metrics`).then(r => r.text());
  assert.match(metricsText, /pool_jobs_created_total/);
  assert.match(metricsText, /pool_template_height/);
  // live connection moves the connections gauge
  const m = await fakeMiner(stratumPort);
  m.send({ id: 1, method: 'mining.subscribe', params: ['intminer/1.0.0'] });
  await m.waitFor(m => m.id === 1);
  const metricsText2 = await fetch(`http://127.0.0.1:${port}/metrics`).then(r => r.text());
  assert.match(metricsText2, /pool_connections 1/);
});

test('two K7 sessions keep distinct extranonce1 (nonce space separation)', async t => {
  const { stratumPort } = await startTestEdge(t, {});
  const m1 = await fakeMiner(stratumPort);
  const m2 = await fakeMiner(stratumPort);
  m1.send({ id: 1, method: 'mining.subscribe', params: ['ckbminer-v1.0.0'] });
  m2.send({ id: 2, method: 'mining.subscribe', params: ['ckbminer-v1.0.0'] });
  const r1 = await m1.waitFor(m => m.id === 1);
  const r2 = await m2.waitFor(m => m.id === 2);
  assert.notStrictEqual(r1.result[1], r2.result[1]);
});

test('block submitter: minimal hex parse-rule form, value-preserving (uints.rs)', () => {
  const { minimalNonceHex } = require('../src/edge/block-submitter.js');
  const { serializeFullHeader } = require('../src/mining/ckb-header.js');
  const f = { version: '0x0', compact_target: '0x191b3f4f', timestamp: '0x1', number: '0x1', epoch: '0x1',
              parent_hash: '0x' + '00'.repeat(32), transactions_root: '0x' + '11'.repeat(32),
              proposals_hash: '0x' + '22'.repeat(32), extra_hash: '0x' + '33'.repeat(32), dao: '0x' + '44'.repeat(32) };
  for (const rawN of [
    '00000000000000000000000000000001',
    '01000000000000000000000000000000',
    'aabbccdd00000001000000000000009b',
    '019ff89d0000002206009d2737d6a758',
    '4ae0c2ff9486d9b0000000753e75b8d',   // odd-length minimal form
  ]) {
    // invariant: LE(value(submitted hex)) == raw miner nonce bytes
    const submitted = minimalNonceHex(rawN);
    assert.match(submitted, /^0x[1-9a-f][0-9a-f]*$/, 'no redundant leading zeros');
    const value = BigInt(submitted);
    const le = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) le[i] = Number((value >> BigInt(8 * i)) & 0xffn);
    const padded = rawN.padStart(32, '0');
    assert.strictEqual(le.toString('hex'), padded, `LE(value(${submitted})) == ${padded}`);
    // and the serialized header nonce region carries exactly those bytes
    const serialized = serializeFullHeader(f, submitted);
    assert.strictEqual(serialized.subarray(192, 208).toString('hex'), padded);
  }
});

test('block submitter: nonce submitted in node LE-value form (live finding 2026-08-13)', () => {
  const { minimalNonceHex, reverseNonceHex } = require('../src/edge/block-submitter.js');
  const raw = '019ff89d0000002206009d2737d6a758';   // real winning share
  assert.strictEqual(reverseNonceHex(raw), '58a7d637279d0006220000009df89f01');
  assert.strictEqual(minimalNonceHex(raw), '0x58a7d637279d0006220000009df89f01');
  // LE(value(submitted)) == raw bytes → the node hashes what the miner hashed
  const value = BigInt(minimalNonceHex(raw));
  const le = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) le[i] = Number((value >> BigInt(8 * i)) & 0xffn);
  assert.strictEqual(le.toString('hex'), raw);
  // palindrome nonces are unaffected (ab*16)
  assert.strictEqual(minimalNonceHex('ab'.repeat(16)), '0x' + 'ab'.repeat(16));
});
