'use strict';
/**
 * config.js — edge configuration loading with conservative defaults.
 *
 * The edge never hard-codes policy values that must be centrally documented
 * (PPLNS window, fee, payout floor) — those live in central deployment config.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  edge: {
    id: 'edge-01',
    region: 'unknown',
    stratumHost: '0.0.0.0',
    stratumPort: 3333,
    statsHost: '127.0.0.1',
    statsPort: 8081,
    network: 'ckb',          // 'ckb' mainnet | 'ckt' testnet
  },
  node: {
    host: '127.0.0.1',
    port: 8114,
    wsPort: 28114,
    pollMs: 250,
    timeoutMs: 8000,
  },
  vardiff: {
    targetShareSec: 30,
    retargetSec: 60,
    variancePercent: 30,
    minDiff: 0.001,
    maxDiff: 1e9,
    initialDiff: 1.0,
    godminerInitialDiff: 65536,
  },
  limits: {
    maxConnectionsPerIp: 64,
    maxConnectionsTotal: 4096,
    idleTimeoutMs: 600_000,
    maxLineBytes: 64 * 1024,
    jsonErrorBudget: 20,
    maxAuthAttempts: 20,
    maxSubmitRatePerSec: 2000,
    maxPendingWriteBytes: 1024 * 1024,
    maxUsernameBytes: 200,
    maxWorkerNameBytes: 64,
  },
  spool: {
    dir: 'spool',
    maxBytes: 512 * 1024 * 1024,
    syncIntervalMs: 1000,
    highWaterBytes: 384 * 1024 * 1024,
  },
  events: {
    bus: 'none',             // 'none' | 'nats' | 'file'
    nats: { servers: ['nats://127.0.0.1:4222'], credsFile: null, stream: 'POOL_V1', tls: false },
    file: { dir: 'spool/export' },
    ackTimeoutMs: 10_000,
    reconnectSec: 5,
  },
};

function loadConfig(overridePath) {
  const p = overridePath || process.env.POOL_CONFIG || path.join(process.cwd(), 'config.json');
  const cfg = structuredClone(DEFAULTS);
  if (fs.existsSync(p)) {
    const user = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.edge = { ...cfg.edge, ...(user.edge || {}) };
    cfg.node = { ...cfg.node, ...(user.node || {}) };
    cfg.vardiff = { ...cfg.vardiff, ...(user.vardiff || {}) };
    cfg.limits = { ...cfg.limits, ...(user.limits || {}) };
    cfg.spool = { ...cfg.spool, ...(user.spool || {}) };
    cfg.events = { ...cfg.events, ...(user.events || {}) };
    cfg.events.nats = { ...cfg.events.nats, ...(user.events?.nats || {}) };
    cfg.events.file = { ...cfg.events.file, ...(user.events?.file || {}) };
  }
  if (!cfg.edge.id || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(cfg.edge.id)) {
    throw new Error(`invalid edge id: ${cfg.edge.id}`);
  }
  // diffToTargetLE (proven upstream) rounds diff×1e6; diffs below 1e-6 round
  // to zero and would divide by zero. Enforce the safe floor at config time.
  if (!(cfg.vardiff.minDiff >= 1e-6)) {
    throw new Error(`vardiff.minDiff must be >= 1e-6 (got ${cfg.vardiff.minDiff})`);
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
