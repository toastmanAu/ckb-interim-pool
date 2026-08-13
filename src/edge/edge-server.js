'use strict';
/**
 * edge-server.js — multi-miner Stratum pool edge.
 *
 * Evolves ckb-stratum-proxy solo-proxy.js @ 4d57892 into a multi-miner,
 * multi-session pool edge. All proven K7/Goldshell wire behavior is preserved
 * (see src/stratum/miner-family.js and its differential tests).
 *
 * Pool additions over the solo proxy:
 *  - unique per-session extranonce1 (multi-miner nonce-collision avoidance);
 *  - username = CKB_ADDRESS[.WORKER] authorization with address validation;
 *  - reject reason codes (spec 03 §9);
 *  - bounded duplicate cache per session;
 *  - connection/rate limiting (spec 06 §5);
 *  - durable accepted-share + block events via an injected sink (Phase 3
 *    spool/publisher implements it; tests inject an in-memory sink);
 *  - metrics + health endpoints.
 */

const net = require('node:net');
const http = require('node:http');
const { uuidv7, createEdgeSeq, extranonce1For } = require('../common/ids.js');
const {
  isGodMiner, subscribeResponseFor, buildNotifyFor, vardiffMessagesFor,
} = require('../stratum/miner-family.js');
const { createVardiff } = require('../stratum/vardiff.js');
const { parseUsername } = require('../stratum/username.js');
const { validateShare, REJECT_REASON } = require('./share-validator.js');
const { targetLEToWorkUnits, workUnitsToQ } = require('../pplns/work-units.js');
const { createMetrics } = require('../common/metrics.js');

const STRATUM_ERROR = {
  LOW_DIFFICULTY: [23, 'Low difficulty share', null],
  UNAUTHORIZED: [24, 'Unauthorized worker', null],
  BAD_NONCE: [20, 'No nonce', null],
  INTERNAL: [21, 'Internal error', null],
};

function createEdgeServer({ config, templateService, blockSubmitter, sink, logger = console, clock = () => Date.now(), metrics = createMetrics() }) {
  const edgeId = config.edge.id;
  const bootId = config.bootId;
  const edgeSeq = createEdgeSeq();
  const limits = config.limits;
  const vardiffCfg = config.vardiff;

  const sessions = new Map();       // sessionId → session
  const perIp = new Map();          // ip → count
  let connectionSeq = 0;

  const totals = {
    blocksFound: 0,
    sharesSubmitted: 0,
    sharesAccepted: 0,
    sharesRejected: 0,
    staleAcked: 0,
    unknownAcked: 0,
    duplicates: 0,
    totalWorkUnits: 0n,          // Σ work_units over accepted shares (BigInt)
    startTime: clock(),
  };

  let healthy = true;
  let healthReason = null;
  const setUnhealthy = (reason) => {
    if (healthy) logger.log('FAIL', `edge unhealthy: ${reason}`);
    healthy = false;
    healthReason = reason;
  };

  // ── session lifecycle ──────────────────────────────────────────────────────
  function createSession(socket) {
    const sessionId = uuidv7();
    const family = 'goldshell';   // refined at subscribe
    const now = clock();
    const dupCache = new Map();
    let dupCount = 0;
    const session = {
      id: sessionId,
      connectionSeq: connectionSeq,   // unique per connection (used for extranonce1)
      socket,
      remoteIp: socket.remoteAddress,
      family,
      authorized: false,
      payoutAddress: null,
      worker: null,
      workerName: 'unknown',
      buffer: '',
      pendingWriteBytes: 0,
      jsonErrors: 0,
      authAttempts: 0,
      lastActivity: now,
      connectedAt: now,
      sharesSubmitted: 0, sharesAccepted: 0, sharesRejected: 0,
      totalShareWork: 0n,
      vardiff: createVardiff(vardiffCfg, clock),
      extranonce1: null,
      dupCache,
      recordShare: key => {
        if (dupCache.has(key)) return false;
        dupCache.set(key, true);
        dupCount++;
        if (dupCount > 4096) {
          const oldest = dupCache.keys().next().value;
          dupCache.delete(oldest);
          dupCount--;
        }
        return true;
      },
    };
    return session;
  }

  // ── wire helpers ───────────────────────────────────────────────────────────
  function sendToMiner(session, obj) {
    if (!session.socket?.writable) return false;
    const line = JSON.stringify(obj) + '\n';
    try {
      const ok = session.socket.write(line);
      session.pendingWriteBytes += Buffer.byteLength(line);
      if (!ok) {
        session.socket.once('drain', () => { session.pendingWriteBytes = 0; });
      }
      if (session.pendingWriteBytes > limits.maxPendingWriteBytes) {
        logger.log('LIMIT', `#${session.id.slice(0, 8)} write pressure — dropping connection`);
        session.socket.destroy();
        return false;
      }
      return true;
    } catch (_) { return false; }
  }

  function sendVardiff(session) {
    metrics.inc('vardiff_changes_total');
    const msgs = vardiffMessagesFor(session.family, session.vardiff.state.currentDiff);
    for (const m of msgs) sendToMiner(session, { id: null, method: m.method, params: m.params });
  }

  function sendJob(session, job, clean) {
    const notify = buildNotifyFor(session.family, job, clean);
    if (notify) sendToMiner(session, notify);
  }

  function broadcastJob(job, clean) {
    for (const s of sessions.values()) {
      if (!s.authorized) continue;
      sendJob(s, job, clean);
    }
  }

  function sendError(session, msgId, code, message) {
    sendToMiner(session, { id: msgId, result: false, error: [code, message, null] });
  }

  // ── share event construction (canonical payload, spec 03 §10) ─────────────
  function buildShareEvent(session, outcome, now) {
    const job = outcome.job;
    const networkWorkUnits = targetLEToWorkUnits(job.targetLE);
    return {
      schema: 'pool.share.accepted.v1',
      event_id: uuidv7(),
      edge_id: edgeId,
      edge_boot_id: bootId,
      edge_seq: edgeSeq.next(),
      session_id: session.id,
      payout_address: session.payoutAddress,
      worker: session.workerName,
      job_id: job.wireJobId,
      template_work_id: job.templateWorkId,
      share_difficulty: outcome.assignedDifficulty,
      share_difficulty_q: outcome.assignedDifficultyQ,
      work_units: outcome.workUnits.toString(),
      network_difficulty_q: workUnitsToQ(networkWorkUnits),
      pow_hash: job.powHash,
      nonce: '0x' + outcome.noncePadded,
      hash: '0x' + outcome.hashHex,
      header_hash_or_header_ref: '0x' + job.powHash,
      accepted_at_ms: now,
      is_block_candidate: outcome.isBlock,
    };
  }

  function buildBlockEvent(session, outcome, submitResult, now) {
    const job = outcome.job;
    // self-contained RawHeader fields for canonical verification (spec 06 §7):
    // computed from the immutable job template with the proven merkle path.
    const headerFields = require('../mining/ckb-merkle.js').templateToHeaderFields(job.template);
    return {
      schema: 'pool.block.submit.v1',
      event_id: uuidv7(),
      edge_id: edgeId,
      edge_boot_id: bootId,
      edge_seq: edgeSeq.next(),
      session_id: session.id,
      payout_address: session.payoutAddress,
      worker: session.workerName,
      job_id: job.wireJobId,
      template_work_id: job.templateWorkId,
      nonce: '0x' + outcome.noncePadded,
      height: job.height,
      parent_hash: job.parentHash,
      candidate_block_hash: null,   // set by node acceptance / central tracking
      node_submit_result: submitResult.ok ? 'accepted' : `rejected:${submitResult.error}`,
      submit_ok: submitResult.ok,
      submit_latency_ms: submitResult.latencyMs,
      submitted_at_ms: now,
      work_units: outcome.workUnits.toString(),
      header: {
        version: headerFields.version,
        compact_target: headerFields.compact_target,
        current_time: headerFields.timestamp,
        number: headerFields.number,
        epoch: headerFields.epoch,
        parent_hash: headerFields.parent_hash,
        transactions_root: headerFields.transactions_root,
        proposals_hash: headerFields.proposals_hash,
        extra_hash: headerFields.extra_hash,
        dao: headerFields.dao,
        nonce: '0x' + outcome.noncePadded,
      },
    };
  }

  // ── block submission (critical path) ───────────────────────────────────────
  async function handleBlockSolution(session, outcome) {
    const submitResult = await blockSubmitter.submitBlock(outcome.noncePadded, outcome.job.template);
    metrics.inc('blocks_found_total', submitResult.ok ? 1 : 0);
    metrics.inc('block_submit_failed_total', submitResult.ok ? 0 : 1);
    if (submitResult.ok) totals.blocksFound++;
    try { await sink.onBlockEvent(buildBlockEvent(session, outcome, submitResult, clock())); }
    catch (e) { logger.log('EVENT', `block event sink error: ${e.message}`); }
    if (submitResult.ok) {
      // force clean job refresh after a find (proven upstream behavior)
      const fresh = templateService.jobs.current;
      if (fresh) broadcastJob(fresh, true);
    }
  }

  // ── stratum message handling ───────────────────────────────────────────────
  async function handleMessage(session, msg) {
    if (!msg || typeof msg.method !== 'string') { session.jsonErrors++; return; }
    session.lastActivity = clock();
    metrics.inc('messages_total');

    switch (msg.method) {
      case 'mining.subscribe': {
        const ua = (msg.params && msg.params[0]) || '';
        session.family = isGodMiner(ua) ? 'godminer' : 'goldshell';
        const isGM = session.family === 'godminer';

        if (isGM) {
          session.extranonce1 = extranonce1For(bootId, session.connectionSeq);
          sendToMiner(session, subscribeResponseFor('godminer', msg.id, msg.params, session.extranonce1));
          session.vardiff.seedForGodminer(clock());
          if (templateService.currentTargetLE) sendVardiff(session);
          const subNotify = buildNotifyFor('godminer', templateService.jobs.current, false);
          if (subNotify) sendToMiner(session, subNotify);
        } else {
          const sessionId = (msg.params && msg.params[1]) || Math.random().toString(16).slice(2, 10);
          session.extranonce1 = sessionId;
          sendToMiner(session, subscribeResponseFor('goldshell', msg.id, msg.params, sessionId));
        }
        metrics.inc(`subscribe_${session.family}_total`);
        break;
      }

      case 'mining.authorize': {
        if (session.authAttempts++ >= limits.maxAuthAttempts) {
          setUnhealthy(`auth abuse from ${session.remoteIp}`);
          session.socket.destroy();
          return;
        }
        const raw = String(msg.params?.[0] ?? '');
        const parsed = parseUsername(raw, config.edge.network, limits);
        if (!parsed.ok) {
          metrics.inc('auth_failed_total');
          logger.log('AUTH', `#${session.id.slice(0, 8)} rejected user "${raw.slice(0, 40)}": ${parsed.reason}`);
          sendToMiner(session, { id: msg.id, result: false, error: [24, `Unauthorized worker: ${parsed.reason}`, null] });
          return;
        }
        session.authorized = true;
        session.payoutAddress = parsed.payoutAddress;
        session.workerName = parsed.worker;
        logger.log('MINE', `#${session.id.slice(0, 8)} authorized as ${session.workerName}@${session.payoutAddress.slice(0, 12)}…`);
        metrics.inc('authorized_miners_total');
        sendToMiner(session, { id: msg.id, result: true, error: null });
        if (templateService.currentTargetLE) sendVardiff(session);
        const notify = buildNotifyFor(session.family, templateService.jobs.current, false);
        if (notify) sendToMiner(session, notify);
        break;
      }

      case 'mining.submit': {
        totals.sharesSubmitted++;
        session.sharesSubmitted++;
        session.vardiff.recordShare();
        const newDiff = session.vardiff.maybeRetarget(clock());
        if (newDiff !== null) sendVardiff(session);

        if (!session.authorized) {
          metrics.inc('shares_unauthorized_total');
          sendToMiner(session, { id: msg.id, result: false, error: STRATUM_ERROR.UNAUTHORIZED });
          return;
        }

        // 3-field K7 [worker, jobId, nonce]; 5-field others [worker, jobId, en2, ntime, nonce]
        const params = msg.params || [];
        const jobIdRaw = String(params[1] ?? '');
        const nonceRaw = params[params.length - 1];
        if (!nonceRaw) {
          metrics.inc('shares_rejected_total');
          sendToMiner(session, { id: msg.id, result: false, error: STRATUM_ERROR.BAD_NONCE });
          return;
        }

        // resolve the exact job the miner named: wire job id is
        // boot-prefixed (8 hex) + 8-hex monotonic seq; the registry is keyed
        // by the trailing seq for backward compatibility with plain ids.
        const jobSeq = parseInt(String(jobIdRaw).slice(-8), 16);
        const job = Number.isFinite(jobSeq) ? templateService.jobs.get(jobSeq) : undefined;
        const isCurrentJob = templateService.currentWireJobId === jobIdRaw;

        // duplicate protection before heavy PoW
        if (!session.recordShare(`${jobIdRaw}:${nonceRaw}`)) {
          totals.duplicates++;
          metrics.inc('shares_duplicate_total');
          logger.log('DUP ', `#${session.id.slice(0, 8)} duplicate ${jobIdRaw}:${nonceRaw}`);
          sendToMiner(session, { id: msg.id, result: false, error: [22, 'Duplicate share', null] });
          return;
        }

        const outcome = validateShare({
          family: session.family,
          extranonce1: session.extranonce1,
          nonceRaw,
          job,
          isCurrentJob,
          minerDiff: session.vardiff.state.currentDiff,
        });

        const isBlock = outcome.isBlock;

        switch (outcome.outcome) {
          case 'rejected': {
            totals.sharesRejected++;
            session.sharesRejected++;
            metrics.inc('shares_rejected_total');
            metrics.inc(`reject_reason_total{reason="${outcome.rejectReason}"}`);
            logger.log('MINE', `#${session.id.slice(0, 8)} share ${outcome.rejectReason} job=${jobIdRaw} diff=${session.vardiff.state.currentDiff} nonce=${nonceRaw} fullNonce=${outcome.noncePadded} hash=${outcome.hashHex ? '0x' + outcome.hashHex.slice(0, 16) : 'n/a'} pow=${outcome.job ? outcome.job.powHash.slice(0, 8) : 'n/a'}`);
            sendToMiner(session, { id: msg.id, result: false, error: STRATUM_ERROR.LOW_DIFFICULTY });
            return;
          }
          case 'acked_unknown': {
            totals.unknownAcked++;
            metrics.inc('shares_unknown_job_total');
            sendToMiner(session, { id: msg.id, result: true, error: null });
            return;
          }
          case 'acked_stale': {
            totals.staleAcked++;
            metrics.inc('shares_stale_acked_total');
            sendToMiner(session, { id: msg.id, result: true, error: null });
            return;
          }
          case 'accepted': {
            totals.sharesAccepted++;
            totals.totalWorkUnits += outcome.workUnits;
            session.sharesAccepted++;
            session.totalShareWork += outcome.workUnits;
            metrics.inc('shares_accepted_total');
            metrics.gauge('accepted_work_units_total', totals.totalWorkUnits);
            logger.log('MINE', `#${session.id.slice(0, 8)} share accepted (${session.workerName})${isBlock ? ' ⚡BLOCK' : ''}`);

            // ack the miner first (low latency), then durable event
            sendToMiner(session, { id: msg.id, result: true, error: null });

            const event = buildShareEvent(session, outcome, clock());
            try { await sink.onShareEvent(event); }
            catch (e) {
              logger.log('EVENT', `share event sink error: ${e.message}`);
              setUnhealthy(`share event sink failure: ${e.message}`);
            }

            if (isBlock) handleBlockSolution(session, outcome);
            return;
          }
        }
        break;
      }

      case 'mining.get_transactions':
        sendToMiner(session, { id: msg.id, result: [], error: null });
        break;

      case 'mining.extranonce.subscribe':
        sendToMiner(session, { id: msg.id, result: true, error: null });
        break;

      case 'mining.suggest_difficulty': {
        const suggested = Number(msg.params?.[0]);
        const applied = session.vardiff.applySuggested(suggested, clock());
        if (applied !== null) {
          logger.log('VDIF', `#${session.id.slice(0, 8)} suggest_difficulty → ${applied}`);
          if (templateService.currentTargetLE) sendVardiff(session);
        }
        sendToMiner(session, { id: msg.id, result: true, error: null });
        break;
      }

      case 'mining.suggest_target':
        sendToMiner(session, { id: msg.id, result: true, error: null });
        break;

      default:
        logger.log('MINE', `#${session.id.slice(0, 8)} unhandled: ${msg.method}`);
        sendToMiner(session, { id: msg.id, result: false, error: [32, `Unsupported method: ${String(msg.method).slice(0, 40)}`, null] });
    }
  }

  // ── TCP server ─────────────────────────────────────────────────────────────
  const useProxyProtocol = !!limits.proxyProtocol;

  /**
   * Parse a PROXY protocol header (v1 text line or v2 binary) and return the
   * reported source address string, or null when more bytes are needed, or
   * 'bad' when the header is malformed. Pair with headerLenFor().
   */
  function parseProxyHeader(buf) {
    if (buf.length >= 16 &&
        buf[0] === 0x0d && buf[1] === 0x0a && buf[2] === 0x0d && buf[3] === 0x0a &&
        buf[4] === 0x00 && buf[5] === 0x0d && buf[6] === 0x0a && buf[7] === 0x51 &&
        buf[8] === 0x55 && buf[9] === 0x49 && buf[10] === 0x54 && buf[11] === 0x0a) {
      // v2: 16-byte header + address length at bytes 14-15
      const len = (buf[14] << 8) | buf[15];
      if (buf.length < 16 + len) return null;
      const fam = buf[13] & 0x0f;   // 0x1 = IPv4, 0x2 = IPv6
      if (fam === 0x1) return `${buf[16]}.${buf[17]}.${buf[18]}.${buf[19]}`;
      if (fam === 0x2) {
        const a = [];
        for (let i = 0; i < 16; i++) a.push(buf[16 + i].toString(16).padStart(2, '0'));
        let out = '';
        for (let i = 0; i < 16; i += 2) {
          if (i > 0) out += ':';
          out += a[i] + a[i + 1];
        }
        return out;
      }
      return 'bad';
    }
    const nl = buf.indexOf('\n');
    if (nl === -1) return buf.length > 200 ? 'bad' : null;
    const line = buf.subarray(0, nl).toString('utf8').trim();
    const m = /^PROXY\s+TCP4\s+(\S+)\s+\S+\s+\d+\s+\d+/.exec(line);
    if (m) return m[1];
    if (/^PROXY\s+UNKNOWN/.test(line)) return 'proxy-unknown';
    return 'bad';
  }

  /** Bytes consumed by the PROXY header in a buffer (for v1/v2). */
  function useProxyProtocolHeaderLen(buf) {
    if (buf.length >= 16 &&
        buf[0] === 0x0d && buf[1] === 0x0a && buf[2] === 0x0d && buf[3] === 0x0a &&
        buf[4] === 0x00 && buf[5] === 0x0d && buf[6] === 0x0a && buf[7] === 0x51 &&
        buf[8] === 0x55 && buf[9] === 0x49 && buf[10] === 0x54 && buf[11] === 0x0a) {
      return 16 + ((buf[14] << 8) | buf[15]);
    }
    const nl = buf.indexOf('\n');
    return nl === -1 ? buf.length : nl + 1;
  }

  const stratumServer = net.createServer(socket => {
    let proxyPending = useProxyProtocol;   // true until the PROXY header is parsed
    let proxyBuf = Buffer.alloc(0);

    connectionSeq++;
    const session = createSession(socket);
    const registerIp = (ip) => {
      const ipCount = (perIp.get(ip) || 0) + 1;
      if (ipCount > limits.maxConnectionsPerIp) {
        metrics.inc('connections_ip_limited_total');
        socket.destroy();
        return false;
      }
      perIp.set(ip, ipCount);
      session.remoteIp = ip;
      return true;
    };

    if (!useProxyProtocol) {
      if (!registerIp(socket.remoteAddress || '?')) return;
    } else if (sessions.size >= limits.maxConnectionsTotal) {
      metrics.inc('connections_total_limited_total');
      socket.destroy();
      return;
    }
    sessions.set(session.id, session);
    metrics.gauge('connections', sessions.size);
    logger.log('MINE', `#${session.id.slice(0, 8)} connected from ${session.remoteIp}`);

    socket.setTimeout(limits.idleTimeoutMs, () => {
      logger.log('MINE', `#${session.id.slice(0, 8)} idle timeout`);
      socket.destroy();
    });

    function processStratum() {
      if (session.buffer.length > limits.maxLineBytes * 2) {
        metrics.inc('connections_overlong_total');
        session.socket.destroy();
        return;
      }
      let nl;
      while ((nl = session.buffer.indexOf('\n')) !== -1) {
        const line = session.buffer.slice(0, nl).trim();
        session.buffer = session.buffer.slice(nl + 1);
        if (!line) continue;
        if (line.length > limits.maxLineBytes) {
          metrics.inc('messages_overlong_total');
          session.jsonErrors++;
          session.socket.destroy();
          return;
        }
        let msg = null;
        try { msg = JSON.parse(line); }
        catch {
          if (++session.jsonErrors > limits.jsonErrorBudget) {
            metrics.inc('connections_json_abuse_total');
            session.socket.destroy();
            return;
          }
          continue;
        }
        handleMessage(session, msg);
      }
    }

    socket.on('data', data => {
      session.lastActivity = clock();
      if (proxyPending) {
        proxyBuf = Buffer.concat([proxyBuf, Buffer.from(data)]);
        const parsed = parseProxyHeader(proxyBuf);
        if (parsed === null) return;                       // need more bytes
        if (parsed === 'bad') { socket.destroy(); return; }
        proxyPending = false;
        if (!registerIp(parsed)) return;                   // limit exceeded
        logger.log('MINE', `#${session.id.slice(0, 8)} (proxy) from ${parsed}`);
        // feed any bytes after the PROXY header into the stratum stream
        const consumed = useProxyProtocolHeaderLen(proxyBuf);
        if (consumed < proxyBuf.length) {
          session.buffer += proxyBuf.subarray(consumed).toString();
          processStratum();
        }
        return;
      }
      session.buffer += data.toString();
      processStratum();
    });

    socket.on('close', () => {
      sessions.delete(session.id);
      const ip = session.remoteIp;
      if (ip && perIp.has(ip)) {
        perIp.set(ip, perIp.get(ip) - 1);
        if (perIp.get(ip) <= 0) perIp.delete(ip);
      }
      metrics.gauge('connections', sessions.size);
      logger.log('MINE', `#${session.id.slice(0, 8)} disconnected`);
    });
    socket.on('error', err => logger.log('MINE', `#${session.id.slice(0, 8)} error: ${err.message}`));

  });

  // ── stats / health server ──────────────────────────────────────────────────
  const statsServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: healthy && templateService.nodeHealthy,
        edge_id: edgeId,
        boot_id: bootId,
        healthy,
        health_reason: healthReason,
        node_healthy: templateService.nodeHealthy,
        has_template: !!templateService.currentTemplate,
        sessions: sessions.size,
      }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics.text());
      return;
    }
    if (req.url === '/' || req.url === '/index.json') {
      const data = {
        edge_id: edgeId, boot_id: bootId, healthy, health_reason: healthReason,
        node_healthy: templateService.nodeHealthy,
        node: `${config.node.host}:${config.node.port}`,
        network: config.edge.network,
        template_age_s: templateService.lastTemplateTime ? Math.floor((clock() - templateService.lastTemplateTime) / 1000) : null,
        block: templateService.currentTemplate ? {
          height: parseInt(templateService.currentTemplate.number, 16),
          work_id: templateService.currentTemplate.work_id,
        } : null,
        totals,
        sessions: [...sessions.values()].map(s => ({
          id: s.id, worker: s.workerName, address: s.payoutAddress,
          family: s.family, authorized: s.authorized, remote_ip: s.remoteIp,
          difficulty: s.vardiff.state.currentDiff,
          shares_submitted: s.sharesSubmitted, shares_accepted: s.sharesAccepted,
          shares_rejected: s.sharesRejected, connected_at: s.connectedAt,
        })),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  // ── lifecycle ──────────────────────────────────────────────────────────────
  templateService.on({
    onNewJob: job => {
      metrics.gauge('template_height', job.height);
      metrics.inc('jobs_created_total');
      broadcastJob(job, job.clean);
    },
    onNodeDown: () => setUnhealthy('CKB node unreachable'),
    onNodeUp: () => { healthy = true; healthReason = null; },
  });

  return {
    totals,
    metrics,
    sessions,
    stratumServer,
    statsServer,
    handleMessage,
    listen() {
      const sp = config.edge.stratumPort;
      const sh = config.edge.stratumHost;
      stratumServer.listen(sp, sh, () => logger.log('EDGE', `Stratum listening on ${sh}:${sp}`));
      const hp = config.edge.statsPort;
      statsServer.listen(hp, config.edge.statsHost, () => logger.log('EDGE', `Stats on http://${config.edge.statsHost}:${hp}/`));
    },
    close() {
      stratumServer.close();
      statsServer.close();
      for (const s of sessions.values()) s.socket.destroy();
      sessions.clear();
    },
  };
}

module.exports = { createEdgeServer, STRATUM_ERROR };
