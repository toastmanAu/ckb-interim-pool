'use strict';
/**
 * admin-server.js — private operator surface (spec 05 §7).
 *
 * Binds 127.0.0.1 ONLY; every request requires the token from
 * POOL_ADMIN_TOKEN (compare via timing-safe hash). Wraps poolctl
 * operations: block states, allocation recompute (read-only audit),
 * miner balances, ledger verify, payout inspection, event replay status.
 *
 * The one state-changing action releases a HELD payout batch to RESERVED.
 * It writes only the database audit row; the wallet still listens on no port
 * and decides whether to broadcast on its next armed tick.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createDb } = require('../accounting/db.js');
const { balanceFor, verifyBlockConservation, auditableBlocks, ACCOUNTS } = require('../accounting/ledger.js');
const { allocateBlock } = require('../pplns/pplns.js');
const { compactToTargetLE } = require('../mining/ckb-target.js');
const { targetLEToWorkUnits } = require('../pplns/work-units.js');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : '';
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (rejected) return;
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        rejected = true;
        reject(new Error('request body is too large'));
      }
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createAdminServer({
  db,
  token = process.env.POOL_ADMIN_TOKEN || '',
  operator = process.env.POOL_ADMIN_OPERATOR || 'admin-console',
  logger = console,
}) {
  const dashboard = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    const suppliedToken = bearerToken(req) || q.token || '';
    const authed = token !== '' && safeEqual(suppliedToken, token);

    if (req.method === 'GET' && url.pathname === '/') {
      if (!authed) return json(res, 401, { error: 'unauthorized' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(dashboard.replace('__TOKEN__', q.token));
    }

    if (!authed) return json(res, 401, { error: 'unauthorized' });
    const [, , ...rest] = url.pathname.split('/');

    switch (rest.join('/')) {
      case 'blocks': {
        const rows = (await db.query(
          `SELECT id::text, state, height, block_hash, reward_shannons, edge_id,
                  found_at, node_accepted_at, matured_at, orphaned_at, config_snapshot_id
           FROM blocks ORDER BY found_at DESC NULLS LAST LIMIT 100`,
        )).rows;
        return json(res, 200, rows);
      }
      case 'blocks/recompute': {
        const b = (await db.query(
          `SELECT * FROM blocks WHERE id::text = $1 OR block_hash = $1`, [q.hash],
        )).rows[0];
        if (!b) return json(res, 404, { error: 'block not found' });
        const stored = (await db.query(
          `SELECT * FROM block_allocations WHERE block_id = $1`, [b.id],
        )).rows[0];
        const shares = (await db.query(
          `SELECT id::text share_id, miner_id::text miner, work_units::text work_units
           FROM share_events WHERE accepted_at <= (SELECT accepted_at FROM share_events WHERE id = $1)
           ORDER BY accepted_at, edge_id, boot_id, edge_seq`,
          [b.candidate_event_id],
        )).rows;
        const template = typeof b.template_json === 'string' ? JSON.parse(b.template_json) : (b.template_json || {});
        const netWork = targetLEToWorkUnits(compactToTargetLE(parseInt(template.compact_target, 16))).toString();
        const recomputed = allocateBlock({
          rewardShannons: b.reward_shannons,
          feeBps: 100,
          windowNum: 2, windowDen: 1,
          networkWork: netWork,
          orderedShares: shares.map(s => ({ shareId: s.share_id, miner: s.miner, workUnits: s.work_units })),
        });
        return json(res, 200, {
          stored_hash: stored?.allocation_hash || null,
          recomputed_hash: recomputed.allocationHash,
          match: !!stored && stored.allocation_hash === recomputed.allocationHash,
          total_work: recomputed.totalWork,
        });
      }
      case 'miner': {
        const m = (await db.query(`SELECT id FROM miners WHERE payout_address = $1`, [q.address])).rows[0];
        if (!m) return json(res, 404, { error: 'unknown miner' });
        const out = { address: q.address };
        for (const [k, v] of Object.entries(ACCOUNTS)) out[k.toLowerCase()] = (await balanceFor(db, m.id, [v])).toString();
        return json(res, 200, out);
      }
      case 'ledger/verify': {
        const blocks = await auditableBlocks(db);
        let conserved = true;
        for (const b of blocks) {
          if (!(await verifyBlockConservation(db, b.id, b.reward_shannons))) conserved = false;
        }
        const dup = (await db.query(
          `SELECT count(*)::int c FROM (SELECT idempotency_key FROM ledger_entries GROUP BY idempotency_key HAVING count(*) > 1) d`,
        )).rows[0].c;
        return json(res, 200, { blocks_checked: blocks.length, conserved, duplicate_idempotency_keys: dup });
      }
      case 'payout': {
        const batch = (await db.query(
          `SELECT * FROM payout_batches WHERE id::text = $1 OR tx_hash = $1 ORDER BY created_at DESC`,
          [q.batch],
        )).rows;
        const items = batch[0] ? (await db.query(
          `SELECT i.miner_id::text, i.amount_shannons, i.state, m.payout_address
           FROM payout_items i JOIN miners m ON m.id = i.miner_id WHERE i.batch_id = $1`,
          [batch[0].id],
        )).rows : [];
        return json(res, 200, { batch, items });
      }
      case 'events': {
        const perEdge = (await db.query(
          `SELECT edge_id, boot_id, count(*)::int events, max(edge_seq) max_seq
           FROM ingested_events GROUP BY edge_id, boot_id ORDER BY edge_id`,
        )).rows;
        return json(res, 200, perEdge);
      }
      case 'treasury': {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        const [snapshots, receipts, held, pending, sweeps] = await Promise.all([
          db.query(
            `SELECT DISTINCT ON (lock_args)
                    lock_args, total_shannons, spendable_shannons, cell_count,
                    owed_shannons, taken_at
               FROM treasury_snapshots
              ORDER BY lock_args, taken_at DESC`,
          ),
          db.query(
            `SELECT r.block_height, r.payout_block_height, r.amount_shannons,
                    r.lock_args, r.payout_tx_hash, r.output_index,
                    r.confirmed_at, r.voided_at, b.block_hash, b.state AS block_state
               FROM treasury_receipts r
               JOIN blocks b ON b.id = r.block_id
              ORDER BY r.block_height DESC LIMIT 100`,
          ),
          db.query(
            `SELECT b.id::text, b.state, b.held_reason, b.created_at,
                    b.released_by, b.released_at,
                    COALESCE(sum(i.amount_shannons), 0)::text AS total_shannons,
                    count(i.*)::int AS recipients
               FROM payout_batches b
               LEFT JOIN payout_items i ON i.batch_id = b.id
              WHERE b.state = 'HELD'
              GROUP BY b.id
              ORDER BY b.created_at DESC`,
          ),
          db.query(
            `SELECT b.id::text, b.state, b.tx_hash, b.created_at,
                    b.broadcast_at, b.confirmed_at,
                    COALESCE(sum(i.amount_shannons), 0)::text AS total_shannons,
                    count(i.*)::int AS recipients
               FROM payout_batches b
               LEFT JOIN payout_items i ON i.batch_id = b.id
              WHERE b.state IN ('RESERVED', 'BUILT', 'BROADCAST')
              GROUP BY b.id
              ORDER BY b.created_at DESC`,
          ),
          db.query(
            `SELECT id::text, state, cold_address, amount_shannons,
                    created_at, built_at, broadcast_at, confirmed_at,
                    tx_hash, fee_shannons, error
               FROM wallet_sweeps
              ORDER BY created_at DESC LIMIT 100`,
          ),
        ]);
        return json(res, 200, {
          snapshots: snapshots.rows,
          receipts: receipts.rows,
          held: held.rows,
          pending: pending.rows,
          sweeps: sweeps.rows,
        });
      }
      case 'batches/release': {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        let body;
        try { body = await readJson(req); }
        catch (error) { return json(res, 400, { error: error.message }); }
        if (typeof body.batchId !== 'string' || !UUID.test(body.batchId)) {
          return json(res, 400, { error: 'batchId must be a UUID' });
        }
        const released = await db.query(
          `UPDATE payout_batches
              SET state = 'RESERVED', released_by = $2, released_at = now()
            WHERE id = $1 AND state = 'HELD'
            RETURNING id::text, state, released_by, released_at`,
          [body.batchId, operator],
        );
        if (released.rowCount === 0) {
          return json(res, 409, { error: `batch ${body.batchId} is not HELD` });
        }
        logger.log('ADMIN', `operator ${operator} released payout batch ${body.batchId}`);
        return json(res, 200, released.rows[0]);
      }
      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(error => {
      logger.log('ADMIN', `request failed: ${error.message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal server error' });
      else res.destroy();
    });
  });
  return { server };
}

module.exports = { createAdminServer };
