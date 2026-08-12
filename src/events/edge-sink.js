'use strict';
/**
 * edge-sink.js — the edge's durable event sink: spool + publisher.
 *
 * onShareEvent/onBlockEvent are called by the edge AFTER the miner ack.
 * Each event is appended to the WAL synchronously (write(2)); the
 * publisher drains the WAL to the bus in edge_seq order. If the WAL append
 * fails (disk), the edge must fail closed — the sink throws, and the edge
 * marks itself unhealthy.
 *
 * On boot, the publisher replays any spooled-but-unacked events (edge
 * restarts / bus outages) before new ones — preserving the per-edge order.
 */

const { createSpool } = require('./spool.js');
const { createPublisher } = require('./publisher.js');

function createEdgeSink({ config, transport, logger = console }) {
  const spool = createSpool({
    dir: config.spool.dir,
    bootId: config.bootId,
    maxBytes: config.spool.maxBytes,
    highWaterBytes: config.spool.highWaterBytes,
    syncIntervalMs: config.spool.syncIntervalMs,
    logger,
  });
  const publisher = createPublisher({
    spool, transport, logger,
    subjectPrefix: config.events?.subjectPrefix || 'pool.v1.edge',
  });

  return {
    spool,
    publisher,
    async onShareEvent(event) {
      const envelope = { seq: event.edge_seq, event_id: event.event_id, body: event };
      try {
        spool.append(envelope);
      } catch (e) {
        logger.log('SPOOL', `WAL append failed: ${e.message}`);
        throw e; // edge fails closed
      }
      publisher.note(envelope);
      return event;
    },
    async onBlockEvent(event) {
      const envelope = { seq: event.edge_seq, event_id: event.event_id, body: event };
      spool.append(envelope);
      publisher.note(envelope);
      return event;
    },
    async replay() {
      await publisher.replaySpool();
    },
    close() {
      spool.close();
      transport.close?.();
    },
  };
}

module.exports = { createEdgeSink };
