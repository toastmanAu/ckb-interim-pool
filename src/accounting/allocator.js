'use strict';
/**
 * allocator.js — run the deterministic PPLNS allocation for a MATURE block
 * and atomically persist: config snapshot → allocation → items → ledger.
 *
 * All in ONE transaction, guarded by a conditional UPDATE (state = MATURE →
 * ALLOCATED): a crash or replay cannot double-allocate. Ledger entries are
 * additionally idempotent (idempotency_key).
 *
 * Network reference work is derived from the block header's compact_target
 * (chain data, never hard-coded): work = (2^256 − 1) / target.
 */

const { allocateBlock } = require('../pplns/pplns.js');
const { compactToTargetLE } = require('../mining/ckb-target.js');
const { targetLEToWorkUnits } = require('../pplns/work-units.js');
const { postEntry, ACCOUNTS } = require('./ledger.js');

async function latestConfig(db) {
  const res = await db.query(
    `SELECT id, pplns_window_num, pplns_window_den, fee_bps, work_encoding_version,
            payout_policy_version, config_json
     FROM config_snapshots ORDER BY active_from DESC LIMIT 1`,
  );
  return res.rows[0] || null;
}

/** Create (or reuse) the active config snapshot for this allocation. */
async function ensureConfigSnapshot(db, { windowNum, windowDen, feeBps }) {
  const doc = {
    pplns_window: `${windowNum}/${windowDen}`,
    fee_bps: feeBps,
    work_encoding_version: 1,
    payout_policy_version: 1,
  };
  const hash = require('node:crypto').createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  const res = await db.query(
    `INSERT INTO config_snapshots (pplns_window_num, pplns_window_den, fee_bps,
                                   work_encoding_version, payout_policy_version,
                                   config_json, config_hash)
     VALUES ($1, $2, $3, 1, 1, $4::jsonb, $5)
     ON CONFLICT (config_hash) DO UPDATE SET config_hash = EXCLUDED.config_hash
     RETURNING id`,
    [windowNum, windowDen, feeBps, JSON.stringify(doc), hash],
  );
  return res.rows[0].id;
}

/**
 * Allocate a MATURE block. Returns { allocated: boolean } — false when the
 * block is not MATURE or was already allocated.
 */
async function allocateMatureBlock(db, { blockId, windowNum = 2, windowDen = 1, feeBps = 100, logger = console }) {
  // single-writer guard: MATURE → ALLOCATED
  const guard = await db.query(
    `UPDATE blocks SET state = 'ALLOCATED'
     WHERE id = $1 AND state = 'MATURE'
     RETURNING id, reward_shannons, candidate_event_id, config_snapshot_id`,
    [blockId],
  );
  if (guard.rowCount === 0) return { allocated: false };
  const block = guard.rows[0];
  const reward = BigInt(block.reward_shannons);

  // canonical share order (spec 07 §9): accepted_at, edge_id, boot_id, edge_seq
  const sharesRes = await db.query(
    `SELECT id::text AS share_id, miner_id::text AS miner, work_units::text AS work_units
     FROM share_events
     WHERE accepted_at <= (SELECT accepted_at FROM share_events WHERE id = $1)
     ORDER BY accepted_at, edge_id, boot_id, edge_seq`,
    [block.candidate_event_id],
  );
  const shares = sharesRes.rows;

  // network reference work from the block's own compact_target
  const netRes = await db.query(`SELECT template_json FROM blocks WHERE id = $1`, [blockId]);
  const template = typeof netRes.rows[0].template_json === 'string'
    ? JSON.parse(netRes.rows[0].template_json) : netRes.rows[0].template_json;
  const networkTargetLE = compactToTargetLE(parseInt(template.compact_target, 16));
  const networkWork = targetLEToWorkUnits(networkTargetLE).toString();

  const cfgId = await ensureConfigSnapshot(db, { windowNum, windowDen, feeBps });

  const result = allocateBlock({
    rewardShannons: reward.toString(),
    feeBps,
    windowNum,
    windowDen,
    networkWork,
    orderedShares: shares.map(s => ({ shareId: s.share_id, miner: s.miner, workUnits: s.work_units })),
  });

  // persist allocation + items + ledger in the same transaction
  const alloc = await db.query(
    `INSERT INTO block_allocations
       (block_id, start_share_id, end_share_id, total_work, distributable_shannons,
        pool_fee_shannons, rounding_shannons, allocation_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (block_id) DO NOTHING
     RETURNING id`,
    [blockId, result.windowStartShareId, result.windowEndShareId, result.totalWork,
     (reward - BigInt(result.feeShannons)).toString(), result.feeShannons,
     result.roundingShannons, result.allocationHash],
  );
  if (alloc.rowCount === 0) return { allocated: false };
  const allocationId = alloc.rows[0].id;

  for (const item of result.allocation) {
    await db.query(
      `INSERT INTO block_allocation_items (allocation_id, miner_id, work_units, credit_shannons)
       VALUES ($1, $2, $3, $4)`,
      [allocationId, item.miner, item.workUnits, item.creditShannons],
    );
    await postEntry(db, {
      accountType: ACCOUNTS.CONFIRMED,
      minerId: item.miner,
      amountShannons: item.creditShannons,
      referenceType: 'block',
      referenceId: blockId,
      idempotencyKey: `alloc:${blockId}:${item.miner}`,
      metadata: { allocationId },
    });
  }
  await postEntry(db, {
    accountType: ACCOUNTS.POOL_FEE,
    amountShannons: result.feeShannons,
    referenceType: 'block',
    referenceId: blockId,
    idempotencyKey: `alloc:${blockId}:pool-fee`,
    metadata: { allocationId },
  });
  if (BigInt(result.roundingShannons) > 0n) {
    await postEntry(db, {
      accountType: ACCOUNTS.ROUNDING,
      amountShannons: result.roundingShannons,
      referenceType: 'block',
      referenceId: blockId,
      idempotencyKey: `alloc:${blockId}:rounding`,
      metadata: { allocationId },
    });
  }
  await db.query(`UPDATE blocks SET state = 'SETTLED_TO_LEDGER', config_snapshot_id = $2 WHERE id = $1`, [blockId, cfgId]);

  logger.log('ALLOC', `block ${blockId.slice(0, 8)} allocated: ${result.allocation.length} miners, fee=${result.feeShannons}`);
  return { allocated: true, result };
}

module.exports = { allocateMatureBlock, ensureConfigSnapshot, latestConfig };
