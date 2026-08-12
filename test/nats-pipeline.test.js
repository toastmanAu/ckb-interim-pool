'use strict';
/**
 * nats-pipeline.test.js — Phase 3 gate: bus outage + replay, exactly-once.
 *
 * Requires a real NATS server. Defaults to nats://127.0.0.1:4223 (the test
 * container started with deploy/nats-test.sh). Skips when unreachable.
 *
 * Scenario:
 *   1. edge boots with the durable sink (spool + JetStream publisher);
 *   2. shares flow while NATS is UP — published immediately;
 *   3. NATS is stopped — shares still flow, spooled locally;
 *   4. NATS restarts — publisher drains the spool;
 *   5. edge restarts with a new boot id — old segment is replayed;
 *   6. consumer sees every event_id exactly once.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { connect, StringCodec, RetentionPolicy } = require('nats');

const { createNatsTransport } = require('../src/events/nats-transport.js');
const { createEdgeSink } = require('../src/events/edge-sink.js');
const { uuidv7 } = require('../src/common/ids.js');

const NATS_URL = process.env.POOL_NATS_URL || 'nats://127.0.0.1:4223';
const STREAM = 'POOL_V1_TEST';

const BOOT_A = uuidv7();
const BOOT_B = uuidv7();
const sc = StringCodec();

function shareEvent(seq, bootId = BOOT_A, eventId = uuidv7()) {
  return {
    schema: 'pool.share.accepted.v1',
    event_id: eventId,
    edge_id: 'test-edge-01',
    edge_boot_id: bootId,
    edge_seq: seq,
    session_id: uuidv7(),
    payout_address: 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v',
    worker: 'k7-01',
    job_id: 'aabbccdd00000001',
    template_work_id: '0x1',
    work_units: '4294967295',
    share_difficulty: '0.9999999997671694',
    share_difficulty_q: '4294967295/4294967296',
    network_difficulty_q: '123456/4294967296',
    pow_hash: 'ab'.repeat(32),
    nonce: '0x' + seq.toString(16).padStart(32, '0'),
    hash: '0x' + 'ef'.repeat(32),
    header_hash_or_header_ref: '0x' + 'ab'.repeat(32),
    accepted_at_ms: Date.now(),
    is_block_candidate: false,
  };
}

async function natsAvailable() {
  try {
    const nc = await connect({ servers: NATS_URL, timeout: 2000 });
    await nc.close();
    return true;
  } catch { return false; }
}

async function drainStream() {
  const nc = await connect({ servers: NATS_URL, timeout: 3000 });
  const jsm = await nc.jetstreamManager();
  const seen = new Map();   // event_id → count
  try {
    const info = await jsm.streams.info(STREAM);
    for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq++) {
      const m = await jsm.streams.getMessage(STREAM, { seq });
      const evt = JSON.parse(sc.decode(m.data));
      seen.set(evt.event_id, (seen.get(evt.event_id) || 0) + 1);
    }
  } catch { /* stream empty */ }
  await nc.close();
  return seen;
}

test('bus outage → spool → replay → exactly-once', { timeout: 90000 }, async t => {
  if (!(await natsAvailable())) {
    t.skip('NATS not reachable — start deploy/nats-test.sh first');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-nats-'));

  console.error("P1 start");
  // clean slate: drop any streams left by previous runs (drills, rehearsals)
  {
    const nc = await connect({ servers: NATS_URL, timeout: 3000 });
    const jsm = await nc.jetstreamManager();
    const it = await jsm.streams.list();
    for await (const s of it) {
      try { await jsm.streams.delete(s.config.name); } catch {}
    }
    await nc.close();
  }

  const config = {
    bootId: BOOT_A,
    spool: { dir, maxBytes: 64 * 1024 * 1024, highWaterBytes: 32 * 1024 * 1024, syncIntervalMs: 50 },
  };

  // ── phase 1: NATS up, events flow ────────────────────────────────────────
  const transport = await createNatsTransport({ servers: [NATS_URL], stream: STREAM, logger: { log: () => {} } }).start();
  const sink = createEdgeSink({ config, transport, logger: { log: () => {} } });
  await sink.replay();

  const up1 = [];
  const down = [];
  for (let i = 1; i <= 3; i++) {
    const evt = shareEvent(i, BOOT_A);
    up1.push(evt.event_id);
    await sink.onShareEvent(evt);
  }

  console.error("P2 wait-for-publication");
  // wait for publication
  await new Promise(r => setTimeout(r, 1000));
  let seen = await drainStream();
  assert.strictEqual(seen.size, 3, '3 events visible before outage');
  assert.ok([...seen.values()].every(c => c === 1), 'no duplicates');

  // ── phase 2: NATS down; shares keep flowing into the spool ───────────────
  execSync('docker stop pool-nats-test >/dev/null 2>&1 || true');
  t.after(() => { try { execSync('docker start pool-nats-test >/dev/null 2>&1'); } catch {} });
  await new Promise(r => setTimeout(r, 300));

  for (let i = 4; i <= 8; i++) {
    const evt = shareEvent(i, BOOT_A);
    down.push(evt.event_id);
    await sink.onShareEvent(evt);   // spool append succeeds; publish fails+retries
  }
  await new Promise(r => setTimeout(r, 500));
  const spooled = fs.readFileSync(path.join(dir, `wal-${BOOT_A}.log`), 'utf8').split('\n').filter(l => l.trim());
  assert.strictEqual(spooled.length, 8, 'all 8 events durably spooled during outage');
  sink.close();

  // ── phase 3: NATS back; new edge boot replays the old segment ────────────
  execSync('docker start pool-nats-test >/dev/null 2>&1');
  await new Promise(r => setTimeout(r, 2000));

  const transport2 = await createNatsTransport({ servers: [NATS_URL], stream: STREAM, logger: { log: () => {} } }).start();
  const sink2 = createEdgeSink({ config: { ...config, bootId: BOOT_B }, transport: transport2, logger: { log: () => {} } });
  await sink2.replay();     // replays wal-BOOT_A.log (4..8) — publisher drains all
  await new Promise(r => setTimeout(r, 2500));
  sink2.close();

  console.error("P5 final drain");
  seen = await drainStream();
  for (const id of [...up1, ...down]) {
    assert.strictEqual(seen.get(id), 1, `event ${id} seen exactly once`);
  }
  console.error("P6 done");
  assert.strictEqual(seen.size, 8, "8 distinct events, no loss, no duplicates.");
});

