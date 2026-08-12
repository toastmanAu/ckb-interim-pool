'use strict';
/**
 * edge.js — pool-edge composition root.
 *
 * Wires config → CKB RPC → template service → block submitter → stratum
 * server, with an injected durable event sink (Phase 3 spool/publisher;
 * tests inject an in-memory sink). The edge has no notion of balances,
 * PPLNS, wallets or final credit decisions (spec 02 §2.1).
 */

const { loadConfig } = require('../common/config.js');
const { uuidv7 } = require('../common/ids.js');
const { createRpcClient } = require('./rpc.js');
const { createTemplateService } = require('./template-service.js');
const { createBlockSubmitter } = require('./block-submitter.js');
const { createEdgeServer } = require('./edge-server.js');
const { createMetrics } = require('../common/metrics.js');

function createEdge({ configPath, sink, logger = console }) {
  const config = loadConfig(configPath);
  config.bootId = config.edge.bootId || config.bootId || uuidv7();

  const rpcClient = createRpcClient(config.node);
  const metrics = createMetrics();
  const templateService = createTemplateService({ config, rpcClient, logger });
  const blockSubmitter = createBlockSubmitter({ rpcClient, logger });
  const edgeServer = createEdgeServer({
    config, templateService, blockSubmitter, sink, logger, metrics,
  });

  return {
    config,
    templateService,
    blockSubmitter,
    edgeServer,
    metrics,
    start() {
      templateService.start();
      edgeServer.listen();
      return this;
    },
    stop() {
      templateService.stop();
      edgeServer.close();
    },
  };
}

module.exports = { createEdge };
