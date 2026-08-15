#!/usr/bin/env node
'use strict';
/**
 * poolctl — operator CLI (spec 04 §14).
 *
 *   poolctl block show <hash>
 *   poolctl block recompute-allocation <hash>
 *   poolctl block recheck <hash|height>     (reopen an ORPHANED verdict)
 *   poolctl miner balance <address>
 *   poolctl ledger verify
 *   poolctl payout dry-run
 *   poolctl payout inspect <batch-id>
 *   poolctl events replay-status
 *
 * Read-only except `payout dry-run` (builds a document, broadcasts nothing)
 * and `block recheck` (reopens a verdict for re-verification; decides nothing
 * itself — the tracker re-proves the state against the node).
 */

const { createDb } = require('./db.js');
const { allocateBlock } = require('../pplns/pplns.js');
const { compactToTargetLE } = require('../mining/ckb-target.js');
const { targetLEToWorkUnits } = require('../pplns/work-units.js');
const { balanceFor, verifyBlockConservation, ACCOUNTS } = require('./ledger.js');

const DB_URL = process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest';

const [,, cmd, ...rest] = process.argv;

async function main() {
  const db = createDb(DB_URL);
  try {
    switch (cmd) {
      case 'block': return await cmdBlock(db, rest);
      case 'miner': return await cmdMiner(db, rest);
      case 'ledger': return await cmdLedger(db, rest);
      case 'payout': return await cmdPayout(db, rest);
      case 'events': return await cmdEvents(db, rest);
      default:
        console.error('usage: poolctl <block|miner|ledger|payout|events> …');
        process.exit(2);
    }
  } finally {
    await db.close();
  }
}

async function cmdBlock(db, [action, hash]) {
  if (action === 'show') {
    const rows = (await db.query(
      `SELECT id::text, state, height, block_hash, reward_shannons, edge_id, found_at,
              node_accepted_at, matured_at, orphaned_at, candidate_event_id::text
       FROM blocks WHERE block_hash = $1 OR id::text = $1`, [hash],
    )).rows;
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (action === 'recompute-allocation') {
    const b = (await db.query(`SELECT * FROM blocks WHERE block_hash = $1 OR id::text = $1`, [hash])).rows[0];
    if (!b) { console.error('block not found'); process.exit(1); }
    const stored = (await db.query(`SELECT * FROM block_allocations WHERE block_id = $1`, [b.id])).rows[0];
    const shares = (await db.query(
      `SELECT id::text share_id, miner_id::text miner, work_units::text work_units
       FROM share_events WHERE accepted_at <= (SELECT accepted_at FROM share_events WHERE id = $1)
       ORDER BY accepted_at, edge_id, boot_id, edge_seq`,
      [b.candidate_event_id],
    )).rows;
    const template = typeof b.template_json === 'string' ? JSON.parse(b.template_json) : b.template_json;
    const netWork = targetLEToWorkUnits(compactToTargetLE(parseInt(template.compact_target, 16))).toString();
    const recomputed = allocateBlock({
      rewardShannons: b.reward_shannons,
      feeBps: stored ? (await db.query(`SELECT fee_bps FROM config_snapshots WHERE id = $1`, [b.config_snapshot_id])).rows[0]?.fee_bps ?? 100 : 100,
      windowNum: 2, windowDen: 1,
      networkWork: netWork,
      orderedShares: shares.map(s => ({ shareId: s.share_id, miner: s.miner, workUnits: s.work_units })),
    });
    const match = stored && stored.allocation_hash === recomputed.allocationHash;
    console.log(JSON.stringify({ stored_hash: stored?.allocation_hash, recomputed_hash: recomputed.allocationHash, match }, null, 2));
    return;
  }
  if (action === 'recheck') {
    // Reopen an ORPHANED verdict for re-verification against the chain.
    //
    // The tracker corrects its own mistakes automatically only while a block
    // is within orphanRecheckDepth of the tip; past that the verdict is final
    // by design (re-polling every historical orphan forever is unbounded
    // work). This is the deliberate, audited way to reopen an older one —
    // needed on 2026-08-15 to recover two canonical blocks written off by a
    // stale tracker four days deep.
    //
    // It does NOT decide anything: it resets the row to NODE_ACCEPTED and
    // lets the running tracker prove canonicality against the node. If the
    // block really was orphaned, the next tick marks it ORPHANED again.
    const b = (await db.query(
      `SELECT id::text, height, state FROM blocks WHERE block_hash = $1 OR id::text = $1 OR height::text = $1`,
      [hash],
    )).rows[0];
    if (!b) { console.error('block not found'); process.exit(1); }
    if (b.state !== 'ORPHANED') {
      console.error(`block ${b.height} is ${b.state}, not ORPHANED — nothing to recheck`);
      process.exit(1);
    }
    await db.query(
      `UPDATE blocks SET state = 'NODE_ACCEPTED', orphaned_at = NULL WHERE id = $1 AND state = 'ORPHANED'`,
      [b.id],
    );
    console.log(JSON.stringify({
      block: b.id, height: b.height, from: 'ORPHANED', to: 'NODE_ACCEPTED',
      note: 'the tracker will re-verify against the node on its next tick; run `poolctl block show` to see the verdict',
    }, null, 2));
    return;
  }
  console.error('usage: poolctl block <show|recompute-allocation|recheck> <hash|height>');
  process.exit(2);
}

async function cmdMiner(db, [action, address]) {
  if (action === 'balance') {
    const m = (await db.query(`SELECT id FROM miners WHERE payout_address = $1`, [address])).rows[0];
    if (!m) { console.log(JSON.stringify({ address, error: 'unknown miner' })); return; }
    const out = {};
    for (const [k, v] of Object.entries(ACCOUNTS)) {
      out[k.toLowerCase()] = (await balanceFor(db, m.id, [v])).toString();
    }
    out.payout_address = address;
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.error('usage: poolctl miner balance <address>');
  process.exit(2);
}

async function cmdLedger(db) {
  // Only blocks that have been ALLOCATED have ledger entries to conserve. A
  // canonical-but-immature block legitimately has a reward and no entries —
  // auditing it reports a "CONSERVATION FAILURE" for a block that is simply
  // waiting for maturity. This must match block-service.js's audit scope; if
  // the operator's audit tool cries wolf, the LedgerConservation alert ("STOP
  // payouts until audited") becomes unactionable.
  const blocks = (await db.query(
    `SELECT id::text, reward_shannons FROM blocks
     WHERE reward_shannons IS NOT NULL AND state IN ('ALLOCATED', 'SETTLED_TO_LEDGER')`,
  )).rows;
  let ok = true;
  for (const b of blocks) {
    const conserved = await verifyBlockConservation(db, b.id, b.reward_shannons);
    if (!conserved) { ok = false; console.error(`CONSERVATION FAILURE: block ${b.id}`); }
  }
  // reported, not audited: visible so an allocation that never runs cannot
  // hide behind an empty check
  const pending = (await db.query(
    `SELECT count(*)::int c FROM blocks
     WHERE reward_shannons IS NOT NULL AND state NOT IN ('ALLOCATED', 'SETTLED_TO_LEDGER')`,
  )).rows[0].c;
  const entries = (await db.query(`SELECT count(*)::int c FROM ledger_entries`)).rows[0].c;
  const dupKeys = (await db.query(
    `SELECT idempotency_key, count(*) c FROM ledger_entries GROUP BY idempotency_key HAVING count(*) > 1`,
  )).rows;
  console.log(JSON.stringify({
    blocks_checked: blocks.length,
    conserved: ok,
    blocks_awaiting_allocation: pending,
    ledger_entries: entries,
    duplicate_idempotency_keys: dupKeys.length,
  }, null, 2));
  if (!ok || dupKeys.length > 0) process.exit(1);
}

async function cmdPayout(db, [action, batchId]) {
  if (action === 'inspect') {
    const batch = (await db.query(`SELECT * FROM payout_batches WHERE id::text = $1 OR tx_hash = $1`, [batchId])).rows;
    const items = batch[0] ? (await db.query(`SELECT * FROM payout_items WHERE batch_id = $1`, [batch[0].id])).rows : [];
    console.log(JSON.stringify({ batch, items }, null, 2));
    return;
  }
  if (action === 'dry-run') {
    const eligible = (await db.query(
      `SELECT m.payout_address, sum(l.amount_shannons)::text amount
       FROM ledger_entries l JOIN miners m ON m.id = l.miner_id
       WHERE l.account_type = $1 GROUP BY m.payout_address
       HAVING sum(l.amount_shannons) >= $2 ORDER BY m.payout_address`,
      [ACCOUNTS.CONFIRMED, '100000000000'],
    )).rows;
    console.log(JSON.stringify({ dry_run: true, broadcast_nothing: true, recipients: eligible.length, eligible }, null, 2));
    return;
  }
  console.error('usage: poolctl payout <inspect <batch-id>|dry-run>');
  process.exit(2);
}

async function cmdEvents(db) {
  const perEdge = (await db.query(
    `SELECT edge_id, boot_id, count(*)::int events, max(edge_seq) max_seq FROM ingested_events
     GROUP BY edge_id, boot_id ORDER BY edge_id`,
  )).rows;
  console.log(JSON.stringify({ per_edge: perEdge }, null, 2));
}

main().catch(e => { console.error('poolctl error:', e.message); process.exit(1); });
