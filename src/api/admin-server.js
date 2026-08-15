'use strict';
/**
 * admin-server.js — private operator surface (spec 05 §7).
 *
 * Binds 127.0.0.1 ONLY; every request requires the token from
 * POOL_ADMIN_TOKEN (compare via timing-safe hash). Wraps poolctl
 * operations: block states, allocation recompute (read-only audit),
 * miner balances, ledger verify, payout inspection, event replay status.
 *
 * No state-changing admin actions here — payouts stay on the timer/CLI.
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

function createAdminServer({ db, token = process.env.POOL_ADMIN_TOKEN || '', logger = console }) {
  const dashboard = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    const authed = token !== '' && safeEqual(q.token, token);

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
      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  return { server: http.createServer(handle) };
}

module.exports = { createAdminServer };
