#!/usr/bin/env node
'use strict';
/**
 * main.js — central accounting consumer.
 *
 *   POOL_DB_URL=postgres://... POOL_NATS_URL=nats://... POOL_STREAM=POOL_V1 \
 *     node src/accounting/main.js [--migrate]
 *
 * Consumes pool.v1.edge.> from JetStream, validates, applies idempotently.
 */

const { connect, StringCodec } = require('nats');
const { createDb } = require('./db.js');
const { processEvent, seqGaps } = require('./ingest.js');

const DB_URL = process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest';
const NATS_URL = process.env.POOL_NATS_URL || 'nats://127.0.0.1:4223';
const STREAM = process.env.POOL_STREAM || 'POOL_V1';
const SUBJECTS = (process.env.POOL_EVENT_SUBJECTS || 'pool.v1.edge.>').split(',').map(s => s.trim());

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = createDb(DB_URL);
  await db.migrate(require('node:path').join(__dirname, '..', '..', 'db', 'migrations'));
  console.log('[INGEST] migrations applied');

  const nc = await connect({ servers: NATS_URL, name: 'pool-ingest' });
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  const sc = StringCodec();

  // ── metrics endpoint (spec 06 §8: accounting) ─────────────────────────────
  const METRICS_PORT = parseInt(process.env.POOL_INGEST_METRICS_PORT || '9101', 10);
  const metrics = { applied: 0, duplicates: 0, invalid: 0, gaps: 0, db_errors: 0, consumed: 0 };
  require('node:http').createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stream: STREAM, subjects: SUBJECTS, ...metrics }));
      return;
    }
    if (req.url === '/metrics') {
      const lines = [
        `pool_ingest_events_applied_total ${metrics.applied}`,
        `pool_ingest_events_duplicate_total ${metrics.duplicates}`,
        `pool_ingest_events_invalid_total ${metrics.invalid}`,
        `pool_ingest_seq_gaps_total ${metrics.gaps}`,
        `pool_ingest_db_errors_total ${metrics.db_errors}`,
        `pool_ingest_events_consumed_total ${metrics.consumed}`,
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(lines.join('\n') + '\n');
      return;
    }
    res.writeHead(404); res.end();
  }).listen(METRICS_PORT, '127.0.0.1', () => {
    console.log(`[INGEST] metrics on http://127.0.0.1:${METRICS_PORT}/metrics`);
  });

  // durable ordered consumer — retry until the stream exists (edges boot
  // independently; central must not crash during their startup window)
  let consumer = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      consumer = await jsm.consumers.info(STREAM, 'accounting');
      break;
    } catch {
      try {
        await jsm.consumers.add(STREAM, {
          name: 'accounting',
          durable_name: 'accounting',
          filter_subjects: SUBJECTS,
          ack_policy: 'explicit',
          deliver_policy: 'all',
          ack_wait: 60 * 1_000_000_000,       // nanoseconds
          max_deliver: -1,
        });
        consumer = await jsm.consumers.info(STREAM, 'accounting');
        break;
      } catch (e) {
        console.warn(`[INGEST] stream/consumer not ready (${e.message.slice(0, 80)}) — retry ${attempt + 1}/60`);
        await sleep(2000);
      }
    }
  }
  if (!consumer) throw new Error('consumer could not be created after 60 attempts');
  const c = await js.consumers.get(STREAM, consumer.config.name);

  let applied = 0, duplicates = 0, invalid = 0;
  const iter = await c.consume();
  console.log('[INGEST] consuming', SUBJECTS.join(','), 'from', STREAM);
  for await (const m of iter) {
    metrics.consumed++;
    let evt;
    try { evt = JSON.parse(sc.decode(m.data)); }
    catch { metrics.invalid++; invalid++; await m.term(); continue; }
    try {
      const r = await processEvent(db, evt);
      if (r.status === 'applied') { metrics.applied++; applied++; }
      else if (r.status === 'duplicate') { metrics.duplicates++; duplicates++; }
      else { metrics.invalid++; invalid++; console.warn('[INGEST] invalid event:', r.errors); }
      await seqGaps(db, evt, (eid, bid, from, to) => {
        metrics.gaps++;
        console.warn(`[INGEST] seq gap ${eid}/${bid}: ${from} → ${to}`);
      });
      await m.ack();
    } catch (e) {
      metrics.db_errors++;
      console.error('[INGEST] apply failed:', e.message, '— requeueing');
      await m.nak(2_000_000_000);
    }
  }
})().catch(e => { console.error('[INGEST] fatal:', e); process.exit(1); });
