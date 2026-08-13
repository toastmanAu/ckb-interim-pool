'use strict';
/**
 * nats-tls.integration.test.js — mTLS event bus verification.
 *
 * Requires: deploy/gen-nats-tls.sh (certs) + a TLS NATS container:
 *   docker run -d --name pool-nats-tls -p 4224:4222 \
 *     -v $PWD/deploy/nats-tls:/etc/nats/tls:ro \
 *     -v $PWD/deploy/nats-server.conf:/etc/nats/nats-server.conf:ro \
 *     -v nats-tls-data:/data \
 *     nats:2.10-alpine -c /etc/nats/nats-server.conf
 *
 * Verifies:
 *  1. edge-au can publish to its own namespace (JetStream stream stores it);
 *  2. edge-au CANNOT subscribe to edge-eu's namespace (permission denied);
 *  3. ingest can consume every edge namespace.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { connect, StringCodec } = require('nats');

const TLS_DIR = path.join(__dirname, '..', 'deploy', 'nats-tls');
const URL = process.env.POOL_NATS_TLS_URL || 'nats://127.0.0.1:4224';
const STREAM = 'POOL_V1';
const sc = StringCodec();

const fs = require('node:fs');
const hasCerts = fs.existsSync(path.join(TLS_DIR, 'ca.crt')) && fs.existsSync(path.join(TLS_DIR, 'edge-au.crt'));

function tlsOpts(prefix) {
  return {
    caFile: path.join(TLS_DIR, 'ca.crt'),
    certFile: path.join(TLS_DIR, `${prefix}.crt`),
    keyFile: path.join(TLS_DIR, `${prefix}.key`),
  };
}

async function connectAs(prefix, extra = {}) {
  return connect({ servers: URL, tls: tlsOpts(prefix), timeout: 4000, ...extra });
}

test('mTLS: per-edge publish isolation + ingest read-all', { timeout: 60000, skip: !hasCerts }, async t => {
  // ── 1. the stream is created centrally with the INGEST credential (edges
  //      are permissioned to append only and cannot create/delete streams)
  const boot = await connectAs('ingest');
  const jsmBoot = await boot.jetstreamManager();
  const it = await jsmBoot.streams.list();
  for await (const s of it) {
    try { await jsmBoot.streams.delete(s.config.name); } catch {}
  }
  await jsmBoot.streams.add({ name: STREAM, subjects: ['pool.v1.edge.>'], retention: 'workqueue' });
  await boot.close();

  // edge-au publishes into its own namespace (append-only perms)
  const au = await connectAs('edge-au');
  const jsAu = au.jetstream();
  const jsmAu = await au.jetstreamManager();
  await jsmAu.streams.info(STREAM);   // read-only INFO is allowed

  const ack = await jsAu.publish('pool.v1.edge.au-adelaide-01.share', sc.encode(JSON.stringify({ event_id: 't1', seq: 1 })), { msgID: 't1' });
  assert.ok(ack.stream === STREAM, 'edge-au publish lands in the stream');

  // edge-au cannot create/delete streams (bootstrap must be central)
  await assert.rejects(
    jsmAu.streams.add({ name: 'POOL_V1_ROGUE', subjects: ['pool.v1.rogue.>'], retention: 'workqueue' }),
    undefined, 'edge-au cannot create streams',
  );

  // ── 2. edge-au cannot subscribe to edge-eu's namespace ───────────────────
  const iter = au.subscribe('pool.v1.edge.eu-frankfurt-01.share')[Symbol.asyncIterator]();
  const forbidden = await Promise.race([
    iter.next().then(() => null, e => e.message),
    new Promise(r => setTimeout(() => r(null), 5000)),
  ]);
  assert.ok(forbidden && /permissions? violation/i.test(forbidden), `edge-au blocked from eu namespace (${forbidden})`);

  // ── 3. ingest reads every edge namespace (JetStream consumer, as prod) ───
  const ingest = await connectAs('ingest');
  const jsIngest = ingest.jetstream();
  const jsmIngest = await ingest.jetstreamManager();
  await jsmIngest.consumers.add(STREAM, {
    name: 'tls-test-ingest', durable_name: 'tls-test-ingest',
    filter_subjects: ['pool.v1.edge.>'], ack_policy: 'explicit', deliver_policy: 'all',
  });
  const c = await jsIngest.consumers.get(STREAM, 'tls-test-ingest');
  const iter2 = await c.consume({ max_messages: 4, timeout: 4000 });

  // publish a eu event from the eu context — ingest must see it
  (async () => {
    const eu = await connectAs('edge-eu');
    await eu.jetstream().publish('pool.v1.edge.eu-frankfurt-01.share', sc.encode(JSON.stringify({ event_id: 't2', seq: 2 })), { msgID: 't2' });
    await eu.close();
  })();

  const events = [];
  for await (const m of iter2) {
    events.push(JSON.parse(sc.decode(m.data)));
    if (events.length >= 2) break;
  }
  const ids = events.map(e => e.event_id).sort();
  assert.ok(ids.includes('t1') && ids.includes('t2'), `ingest saw both edges' events: ${ids.join(',')}`);

  await au.close();
  await ingest.close();
});
