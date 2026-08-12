'use strict';
/**
 * template-service.js — trusted-local-node template acquisition and job
 * creation for the pool edge.
 *
 * Proven upstream behavior (ckb-stratum-proxy solo-proxy.js @ 4d57892):
 *  - get_block_template polling (POLL_MS) plus new_tip_header WebSocket
 *    push subscription, with exponential reconnect backoff;
 *  - same-job detection: identical work_id AND parent_hash → no new job, and
 *    current_time is never mutated (the header is committed in pow_hash);
 *  - pow_hash computed from template fields via ckb-merkle + ckb-header;
 *  - template watchdog logging when no fresh template arrives;
 *  - node health state with failure counting.
 *
 * Spec-driven deviation (documented in IMPLEMENTATION-NOTES §2.5): clean_jobs
 * is true when parent_hash changes (new tip invalidates prior work, spec 03
 * §5.4); false for same-parent template refreshes.
 */

const { computePowHash } = require('../mining/ckb-header.js');
const merkle = require('../mining/ckb-merkle.js');
const { compactToTargetLE } = require('../mining/ckb-target.js');
const { createJobRegistry } = require('../stratum/job-registry.js');
const { jobIdFor } = require('../common/ids.js');

const WebSocket = require('ws');

function createTemplateService({ config, rpcClient, logger = console, jobs = createJobRegistry() }) {
  const nodeCfg = config.node;
  const edgeId = config.edge.id;
  let bootId = config.bootId;

  let currentTemplate = null;   // raw get_block_template result
  let currentPowHash = null;
  let currentTargetLE = null;
  let currentJobId = 0;         // monotonic per-boot job sequence
  let currentWireJobId = null;
  let lastTemplateTime = 0;
  let lastParentHash = null;
  let nodeHealthy = true;
  let nodeFailCount = 0;

  const listeners = new Set();  // { onNewJob(jobSnapshot), onNodeDown, onNodeUp }
  const on = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const emit = (name, arg) => { for (const l of listeners) if (l[name]) l[name](arg); };

  let fetchInFlight = false;
  let pollTimer = null;
  let watchdogTimer = null;
  let ws = null;
  let wsReconnectTimer = null;
  let wsBackoffMs = 1000;
  const WS_BACKOFF_MAX = 30000;

  async function fetchTemplate() {
    if (fetchInFlight) return;
    fetchInFlight = true;
    try {
      const tpl = await rpcClient.rpc('get_block_template', [null, null, null]);

      if (currentTemplate &&
          tpl.work_id === currentTemplate.work_id &&
          tpl.parent_hash === currentTemplate.parent_hash) {
        lastTemplateTime = Date.now();
        return;
      }

      if (!nodeHealthy) {
        logger.log('NODE', `CKB node recovered after ${nodeFailCount} failures`);
        nodeHealthy = true;
        nodeFailCount = 0;
        emit('onNodeUp', {});
      }

      const parentChanged = currentTemplate && tpl.parent_hash !== currentTemplate.parent_hash;
      currentTemplate = tpl;
      lastParentHash = tpl.parent_hash;
      currentJobId = (currentJobId + 1) & 0xffffffff;
      lastTemplateTime = Date.now();

      const fields = merkle.templateToHeaderFields(tpl);
      currentPowHash = computePowHash(fields);
      currentTargetLE = compactToTargetLE(parseInt(tpl.compact_target, 16));
      currentWireJobId = jobIdFor(bootId, currentJobId);

      const snapshot = {
        jobId: currentJobId,
        wireJobId: currentWireJobId,
        templateWorkId: tpl.work_id,
        powHash: currentPowHash,
        targetLE: currentTargetLE,
        height: parseInt(tpl.number, 16),
        parentHash: tpl.parent_hash,
        clean: parentChanged,          // new tip invalidates prior work
        template: tpl,
      };
      jobs.add(snapshot);
      emit('onNewJob', snapshot);
      return snapshot;
    } catch (e) {
      nodeFailCount++;
      if (nodeHealthy) {
        logger.log('NODE', `CKB node error: ${e.message}`);
        nodeHealthy = false;
        emit('onNodeDown', { error: e.message });
      } else if (nodeFailCount % 240 === 0) {
        logger.log('NODE', `Still unreachable after ${nodeFailCount} attempts`);
      }
      return null;
    } finally {
      fetchInFlight = false;
    }
  }

  // ── WebSocket new_tip_header subscription (push) ──────────────────────────
  let stopped = false;

  function startWsSubscription() {
    if (ws || stopped) return;
    const url = `ws://${nodeCfg.host}:${nodeCfg.wsPort}/`;
    let liveSub = false;
    try { ws = new WebSocket(url); }
    catch (e) { logger.log('WS', `connect failed: ${e.message}`); scheduleWsReconnect(); return; }

    ws.on('open', () => {
      wsBackoffMs = 1000;
      ws.send(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'subscribe', params: ['new_tip_header'] }));
    });
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.id === 1 && msg.result !== undefined) {
        liveSub = true;
        return;
      }
      if (msg.id === 1 && msg.error) {
        logger.log('WS', `subscribe error: ${JSON.stringify(msg.error)} — poll-only`);
        return;
      }
      if (msg.method === 'subscribe' && msg.params) fetchTemplate();
    });
    ws.on('error', e => logger.log('WS', `socket error: ${e.message}`));
    ws.on('close', () => {
      if (liveSub) logger.log('WS', `disconnected — reconnecting in ${wsBackoffMs}ms`);
      ws = null;
      scheduleWsReconnect();
    });
  }

  function scheduleWsReconnect() {
    clearTimeout(wsReconnectTimer);
    if (stopped) return;
    wsReconnectTimer = setTimeout(() => {
      if (stopped) return;
      wsBackoffMs = Math.min(wsBackoffMs * 2, WS_BACKOFF_MAX);
      startWsSubscription();
    }, wsBackoffMs);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  function start() {
    fetchTemplate();
    startWsSubscription();
    pollTimer = setInterval(fetchTemplate, nodeCfg.pollMs || 250);
    watchdogTimer = setInterval(() => {
      if (!lastTemplateTime) return;
      const staleSec = Math.floor((Date.now() - lastTemplateTime) / 1000);
      if (staleSec > 300) logger.log('WARN', `Template is ${staleSec}s old — CKB node may be stuck or offline`);
    }, 60000);
    return this;
  }

  function stop() {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(watchdogTimer);
    clearTimeout(wsReconnectTimer);
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  return {
    start, stop, on, fetchTemplate, jobs,
    get currentTemplate() { return currentTemplate; },
    get currentPowHash() { return currentPowHash; },
    get currentTargetLE() { return currentTargetLE; },
    get currentWireJobId() { return currentWireJobId; },
    get nodeHealthy() { return nodeHealthy; },
    get lastTemplateTime() { return lastTemplateTime; },
    get edgeId() { return edgeId; },
    get bootId() { return bootId; },
  };
}

module.exports = { createTemplateService };
