'use strict';
/**
 * nats-transport.js — NATS JetStream publisher transport.
 *
 * Production transport (spec 02 §2.2): durable stream, per-edge subject
 * namespaces, TLS + per-edge credentials are deployment configuration.
 *
 * Stream: "POOL_V1" (configurable). Subject pattern pool.v1.edge.<edge_id>.*
 * Duplicate ack semantics: JetStream acks once the message is durably
 * stored — at-least-once delivery is then enforced by DB unique constraints.
 */

const { connect, StringCodec } = require('nats');

function createNatsTransport({ servers = ['nats://127.0.0.1:4222'], stream = 'POOL_V1', credsFile = null, tls = false, subjects = ['pool.v1.edge.>'], logger = console }) {
  const sc = StringCodec();
  let nc = null;
  let js = null;

  async function start() {
    const opts = { servers, name: 'pool-edge-publisher' };
    if (credsFile) opts.authenticator = require('nats').credsAuthenticator(fs.readFileSync(credsFile));
    if (tls) opts.tls = {};
    nc = await connect(opts);
    js = nc.jetstream();
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.info(stream);
    } catch {
      await jsm.streams.add({ name: stream, subjects, retention: 'workqueue' });
    }
    logger.log('NATS', `connected to ${servers.join(',')} stream=${stream}`);
    return this;
  }

  async function publish(subject, event) {
    const ack = await js.publish(subject, sc.encode(JSON.stringify(event)), {
      msgID: event.event_id,          // JetStream dedup on redelivery of same event_id
    });
    // Fail loud: if no stream matched the subject, the message was silently
    // dropped — the publisher must retry, never treat this as published.
    if (!ack.stream || ack.stream.length === 0) {
      throw new Error(`publish to ${subject} matched no stream`);
    }
    return ack;
  }

  async function close() {
    // close immediately: publishes are acked before publish() resolves, so
    // there is no buffered data to drain — drain() on a down server blocks.
    try { await nc?.close(); } catch {}
  }

  return { start, publish, close, get connected() { return !!nc && !nc.isClosed(); } };
}

module.exports = { createNatsTransport };
