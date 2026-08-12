'use strict';
/**
 * publisher.js — drains the edge spool to the event bus in edge-seq order.
 *
 * Delivery semantics: at-least-once (decision 10). The bus transport
 * (NATS JetStream) must durably accept a message before the publisher
 * considers it published; central accounting dedups by event_id +
 * (edge_id, boot_id, edge_seq) unique constraints.
 *
 * Ordering: events are published strictly in edge_seq order (one in-flight
 * publish at a time) so the bus/consumer sees a per-edge ordered stream —
 * required for PPLNS share traversal and sequence-gap detection.
 *
 * On transport failure: publishing pauses and retries with backoff; the
 * spool holds the backlog. The edge keeps mining as long as the spool has
 * capacity (spec 02 §4.3).
 */

const { validate } = require('./validate.js');

function createPublisher({ spool, transport, logger = console, ackTimeoutMs = 10000, reconnectMs = 5000, subjectPrefix = 'pool.v1.edge' }) {
  const subjectFor = e => `${subjectPrefix}.${e.edge_id}.${e.schema === 'pool.block.submit.v1' ? 'block_submit' : e.schema === 'pool.share.accepted.v1' ? 'share' : e.schema}`;

  const pending = [];      // records appended since last drain
  let draining = false;
  let failed = false;
  let lastError = null;
  let onFailure = null;    // callback when the bus is down (edge marks degraded)
  let retryTimer = null;

  function note(event) {
    pending.push(event);
    if (!draining) drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const rec = pending[0];
        const evt = { ...rec.body, event_id: rec.event_id, edge_seq: rec.seq };
        const ok = await publishOne(evt);
        if (!ok) {
          failed = true;
          lastError = 'transport publish failed';
          if (onFailure) onFailure(lastError);
          scheduleRetry();
          return;
        }
        pending.shift();
      }
      if (failed) {
        failed = false;
        lastError = null;
        if (onFailure) onFailure(null);
      }
    } finally {
      draining = false;
    }
  }

  async function publishOne(evt) {
    const v = validate(evt);
    if (!v.ok) {
      // Structural corruption: drop with an explicit log + metric — the event
      // cannot be fixed automatically. Never retry corrupt data forever.
      logger.log('PUB', `dropping invalid event (${v.errors}): ${evt.event_id}`);
      return true;
    }
    try {
      await Promise.race([
        transport.publish(subjectFor(evt), evt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('publish timeout')), ackTimeoutMs)),
      ]);
      return true;
    } catch (e) {
      logger.log('PUB', `publish failed: ${e.message}`);
      return false;
    }
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (pending.length > 0) drain();
    }, reconnectMs);
  }

  /** Publish any spool records that were never acked (boot-time replay). */
  async function replaySpool() {
    const records = spool.replay();
    for (const rec of records) note(rec);
  }

  return {
    note, drain, replaySpool, publishOne, subjectFor,
    set onFailure(fn) { onFailure = fn; },
    get failed() { return failed; },
    get pendingCount() { return pending.length; },
  };
}

module.exports = { createPublisher };
