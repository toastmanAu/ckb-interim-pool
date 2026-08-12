#!/usr/bin/env node
'use strict';
/**
 * main.js — pool-edge entry point.
 *
 *   node src/edge/main.js [config.json]
 *   POOL_CONFIG=/path/config.json node src/edge/main.js
 *
 * Requires a local trusted CKB node (config.node). The event sink is
 * selected by config.events.bus: 'none' (default), 'nats', or 'file'.
 */

const { createEdge } = require('./edge.js');

// Self-test the proven primitives before serving miners.
require('../mining/blake2b.js').selftest();
require('../mining/eaglesong.js').selftest();

async function buildSink(config) {
  switch (config.events.bus) {
    case 'nats': {
      const { createNatsTransport } = require('../events/nats-transport.js');
      const { createEdgeSink } = require('../events/edge-sink.js');
      const transport = await createNatsTransport(config.events.nats).start();
      const sink = createEdgeSink({ config, transport });
      await sink.replay();
      return sink;
    }
    case 'file': {
      const { createFileTransport } = require('../events/file-transport.js');
      const { createEdgeSink } = require('../events/edge-sink.js');
      const transport = await createFileTransport(config.events.file).start();
      const sink = createEdgeSink({ config, transport });
      await sink.replay();
      return sink;
    }
    case 'none':
    default:
      // In-memory only — acceptable for local single-process testing where the
      // consumer is embedded; production regions must use a durable bus/spool.
      const { createMemorySink } = require('../events/memory-sink.js');
      return createMemorySink();
  }
}

(async () => {
  const configPath = process.argv[2] || process.env.POOL_CONFIG;
  const config = require('../common/config.js').loadConfig(configPath);
  console.log(`[EDGE] boot edge=${config.edge.id} boot=${config.bootId || '(new)'} bus=${config.events.bus}`);
  const sink = await buildSink(config);
  const edge = createEdge({ configPath, sink });
  edge.start();
  process.on('SIGINT', () => { edge.stop(); process.exit(0); });
  process.on('SIGTERM', () => { edge.stop(); process.exit(0); });
})().catch(e => {
  console.error('[EDGE] fatal:', e);
  process.exit(1);
});
