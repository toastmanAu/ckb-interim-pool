'use strict';
/**
 * api-server.js — read-only public API (spec 05 §6).
 *
 * Never on the mining/accounting critical path. Miner endpoints are
 * address-addressed and public (like a pool explorer); no IPs, session ids,
 * internal edge sequences or security metadata are exposed.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { balanceFor, ACCOUNTS } = require('../accounting/ledger.js');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

function createApiServer({ db, policy = {}, nodeRpc = null, logger = console }) {
  const feeBps = policy.feeBps ?? 100;
  const pplnsWindow = policy.pplnsWindow ?? '2.0';
  const minPayout = policy.minimumPayoutShannons ?? '100000000000';

  const routes = {
    async 'GET /api/v1/pool'(req, res) {
      const hr = async (seconds) => {
        const res = await db.query(
          `SELECT COALESCE(sum(work_units),0)::text w FROM share_events
           WHERE accepted_at > now() - make_interval(secs => $1)`,
          [seconds],
        );
        return (BigInt(res.rows[0].w) * 1000n / BigInt(seconds * 1000)).toString();
      };
      const [h10, h1h, h24h, workers, miners, round] = await Promise.all([
        hr(600), hr(3600), hr(86400),
        db.query(`SELECT count(DISTINCT worker_id)::int c, count(DISTINCT session_id)::int s FROM share_events WHERE accepted_at > now() - interval '1 hour'`),
        db.query(`SELECT count(DISTINCT miner_id)::int c FROM share_events WHERE accepted_at > now() - interval '1 hour'`),
        db.query(`SELECT COALESCE(sum(work_units),0)::text w FROM share_events`),
      ]);
      const lastBlock = (await db.query(
        `SELECT block_hash, height, state, found_at FROM blocks ORDER BY found_at DESC NULLS LAST LIMIT 1`,
      )).rows[0] || null;
      return json(res, 200, {
        hashrate_10m: h10[0].w, hashrate_1h: h1h[0].w, hashrate_24h: h24h[0].w,
        active_workers: workers.rows[0].c, active_sessions: workers.rows[0].s,
        active_miners: miners.rows[0].c,
        round_work: round.rows[0].w,
        fee_bps: feeBps,
        pplns_window: pplnsWindow,
        minimum_payout_shannons: minPayout,
        last_block: lastBlock,
        custodial: true,
        status: 'ok',
      });
    },

    async 'GET /api/v1/network'(req, res) {
      if (!nodeRpc) return json(res, 200, { available: false });
      try {
        const tip = await nodeRpc.rpc('get_tip_header', []);
        return json(res, 200, {
          available: true,
          tip_height: parseInt(tip.number, 16),
          epoch: tip.epoch,
          compact_target: tip.compact_target,
        });
      } catch (e) {
        return json(res, 200, { available: false, error: e.message });
      }
    },

    async 'GET /api/v1/edges'(req, res) {
      const rows = (await db.query(
        `SELECT e.id, e.region, e.name, e.status, e.last_seen_at,
                (SELECT max(edge_seq) FROM share_events s WHERE s.edge_id = e.id) AS last_seq
         FROM edges e ORDER BY e.id`,
      )).rows;
      return json(res, 200, rows);
    },

    async 'GET /api/v1/blocks'(req, res) {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
      const cursor = req.query.cursor || null;
      const rows = (await db.query(
        `SELECT block_hash, height, state, reward_shannons, edge_id, found_at,
                node_accepted_at, matured_at
         FROM blocks
         WHERE ($1::text IS NULL OR found_at < $1::timestamptz)
         ORDER BY found_at DESC NULLS LAST
         LIMIT $2`,
        [cursor, limit],
      )).rows;
      return json(res, 200, {
        blocks: rows,
        next_cursor: rows.length === limit ? rows[rows.length - 1].found_at : null,
      });
    },

    async 'GET /api/v1/miners/:address'(req, res) {
      const addr = req.params.address;
      const m = (await db.query(`SELECT id, payout_address, network, first_seen_at, last_seen_at FROM miners WHERE payout_address = $1`, [addr])).rows[0];
      if (!m) return json(res, 404, { error: 'unknown miner' });
      const [balances, stats] = await Promise.all([
        (async () => {
          const out = {};
          for (const [k, v] of Object.entries(ACCOUNTS)) out[k.toLowerCase()] = (await balanceFor(db, m.id, [v])).toString();
          return out;
        })(),
        db.query(
          `SELECT count(*)::int shares, COALESCE(sum(work_units),0)::text work,
                  COALESCE(sum(work_units) FILTER (WHERE accepted_at > now() - interval '1 hour'),0)::text work_1h
           FROM share_events WHERE miner_id = $1`,
          [m.id],
        ),
      ]);
      const workers = (await db.query(
        `SELECT w.worker_name, count(s.id)::int shares, max(s.accepted_at) last_share_at
         FROM share_events s JOIN workers w ON w.id = s.worker_id
         WHERE s.miner_id = $1 GROUP BY w.worker_name ORDER BY w.worker_name`,
        [m.id],
      )).rows;
      return json(res, 200, {
        address: m.payout_address, network: m.network,
        first_seen_at: m.first_seen_at, last_seen_at: m.last_seen_at,
        balances, stats: stats.rows[0], workers,
      });
    },

    async 'GET /api/v1/miners/:address/workers'(req, res) {
      const addr = req.params.address;
      const rows = (await db.query(
        `SELECT w.worker_name, count(s.id)::int shares, COALESCE(sum(s.work_units),0)::text work,
                max(s.accepted_at) last_share_at
         FROM miners m JOIN workers w ON w.miner_id = m.id
         LEFT JOIN share_events s ON s.worker_id = w.id
         WHERE m.payout_address = $1 GROUP BY w.worker_name ORDER BY w.worker_name`,
        [addr],
      )).rows;
      return json(res, 200, rows);
    },

    async 'GET /api/v1/miners/:address/shares'(req, res) {
      const addr = req.params.address;
      const window = ['1h', '24h', '7d'].includes(req.query.window) ? req.query.window : '1h';
      const secs = { '1h': 3600, '24h': 86400, '7d': 604800 }[window];
      const rows = (await db.query(
        `SELECT s.accepted_at, s.work_units, s.is_block_candidate, w.worker_name
         FROM share_events s JOIN miners m ON m.id = s.miner_id JOIN workers w ON w.id = s.worker_id
         WHERE m.payout_address = $1 AND s.accepted_at > now() - make_interval(secs => $2)
         ORDER BY s.accepted_at DESC LIMIT 500`,
        [addr, secs],
      )).rows;
      return json(res, 200, rows);
    },

    async 'GET /api/v1/miners/:address/payouts'(req, res) {
      const addr = req.params.address;
      const rows = (await db.query(
        `SELECT pb.id::text batch_id, pb.state, pb.broadcast_at, pb.confirmed_at, pb.tx_hash,
                pi.amount_shannons, pi.state item_state
         FROM miners m JOIN payout_items pi ON pi.miner_id = m.id
         JOIN payout_batches pb ON pb.id = pi.batch_id
         WHERE m.payout_address = $1 ORDER BY pb.created_at DESC LIMIT 100`,
        [addr],
      )).rows;
      return json(res, 200, rows);
    },

    async 'GET /api/v1/policy'(req, res) {
      return json(res, 200, {
        custodial: true,
        model: 'difficulty-weighted PPLNS',
        pplns_window: pplnsWindow,
        fee_bps: feeBps,
        minimum_payout_shannons: minPayout,
        maturity: '4 epochs (CKB consensus)',
        disclaimer: 'Operator-custodied interim pool — rewards are paid from the pool hot wallet after canonical confirmation and maturity.',
      });
    },
  };

  function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathSegs = url.pathname.split('/').filter(Boolean);   // api,v1,miners,:address,...
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(DASHBOARD_HTML);
    }
    let handler = null;
    let params = {};
    if (pathSegs[0] === 'api' && pathSegs[1] === 'v1') {
      const rest = pathSegs.slice(2);
      const key0 = `GET /api/v1/${rest[0]}`;
      if (rest.length === 1) handler = routes[key0];
      else if (rest[0] === 'miners') {
        const mkey = `GET /api/v1/miners/:address/${rest[2] || ''}`;
        handler = routes[rest.length === 2 ? 'GET /api/v1/miners/:address' : mkey];
        params = { address: rest[1] };
      } else if (rest[0] === 'blocks') {
        handler = routes['GET /api/v1/blocks'];
      }
    }
    req.params = params;
    req.query = Object.fromEntries(url.searchParams);
    if (handler) handler(req, res).catch(e => {
      logger.log('API', `error: ${e.message}`);
      json(res, 500, { error: 'internal' });
    });
    else json(res, 404, { error: 'not found' });
  }

  return { server: http.createServer(handle), routes };
}

module.exports = { createApiServer };
