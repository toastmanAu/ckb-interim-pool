'use strict';
/**
 * reconciler.js — what did the pool actually earn?
 *
 * A CKB cellbase in block N pays the miner of block N-11. Reading our own
 * block's cellbase therefore reports a STRANGER's reward, which is how
 * accounting over-recorded block 20160918 by 154.48 CKB on 2026-08-15.
 *
 * The correct source is block H+11's cellbase output whose lock matches the
 * lock recorded in block H's OWN cellbase witness. Reading the lock from the
 * witness rather than from configuration is what makes a block_assembler
 * change (2026-08-15) harmless to historical attribution.
 */

const { parseCellbaseWitness } = require('./cellbase-witness.js');
const { parseEpoch } = require('../mining/ckb-header.js');

/** CKB pays a block's reward in the cellbase 11 blocks later. */
const REWARD_DELAY_BLOCKS = 11;
/** A cellbase output is unspendable for this many epochs. */
const CELLBASE_MATURITY_EPOCHS = 4;

function sameLock(a, b) {
  return a.code_hash === b.code_hash && a.hash_type === b.hash_type && a.args === b.args;
}

/**
 * @param {object} p
 * @param {number} p.blockHeight       height of the block we mined (H)
 * @param {string} p.cellbaseWitness   block H's cellbase witness hex
 * @param {object} p.payoutBlock       block H+11 ({header:{number,epoch}, transactions:[cellbase]})
 * @returns {null|{lockArgs:string, payoutBlockHeight:number, payoutTxHash:string,
 *                 outputIndex:number, amountShannons:string, matureAtEpoch:number}}
 */
function matchReceipt({ blockHeight, cellbaseWitness, payoutBlock }) {
  const { lock } = parseCellbaseWitness(cellbaseWitness);
  const expected = blockHeight + REWARD_DELAY_BLOCKS;
  const actual = parseInt(payoutBlock.header.number, 16);
  if (actual !== expected) {
    throw new Error(`payout block height ${actual} != expected ${expected} for block ${blockHeight}`);
  }

  const cellbase = payoutBlock.transactions[0];
  if (!cellbase) throw new Error(`payout block ${actual} has no cellbase`);

  const matches = [];
  cellbase.outputs.forEach((out, index) => {
    if (out.lock && sameLock(out.lock, lock)) matches.push({ index, capacity: BigInt(out.capacity) });
  });
  // absence of a matching output is a real answer (we did not earn it), not an error
  if (matches.length === 0) return null;

  const total = matches.reduce((acc, m) => acc + m.capacity, 0n);
  const epoch = parseEpoch(payoutBlock.header.epoch);
  // A CKB epoch carries a fraction (index/length) and cellbase maturity is
  // measured on the full EpochNumberWithFraction. Truncating to the integer
  // number reports maturity up to a whole epoch EARLY, and a spend gated on
  // that is rejected by the node as immature. Round UP so the recorded value
  // is never early: at worst it delays a spend by part of an epoch.
  const matureAtEpoch = epoch.number + (epoch.index > 0 ? 1 : 0) + CELLBASE_MATURITY_EPOCHS;
  return {
    lockArgs: lock.args,
    payoutBlockHeight: actual,
    payoutTxHash: cellbase.hash,
    // if a cellbase ever pays our lock in several outputs, the amount is their
    // sum and the index records the first — the UNIQUE(tx,index) key still holds
    outputIndex: matches[0].index,
    amountShannons: total.toString(),
    matureAtEpoch,
  };
}

module.exports = { matchReceipt, REWARD_DELAY_BLOCKS, CELLBASE_MATURITY_EPOCHS };

/**
 * Persistent reconciliation over the `blocks` table.
 *
 * Rules, all of them lessons from 2026-08-14/15:
 *  - a null or failed lookup records nothing (missing evidence is not a zero);
 *  - a receipt confirms only once its payout block is `confirmations` deep;
 *  - if the payout block's cellbase tx hash changes before confirmation, the
 *    receipt is voided rather than confirmed.
 */
function createReconciler({ db, rpcClient, confirmations = 20, logger = console }) {
  const hx = n => '0x' + BigInt(n).toString(16);

  async function blockAt(height) {
    try { return await rpcClient.rpc('get_block_by_number', [hx(height)]); }
    catch (e) { logger.log('WALLET', `get_block_by_number(${height}) failed: ${e.message}`); return null; }
  }

  async function reconcileBlock(row, tipHeight) {
    const height = parseInt(row.height, 10);
    const payoutHeight = height + REWARD_DELAY_BLOCKS;
    if (payoutHeight > tipHeight) return;                    // not paid yet

    const mined = await blockAt(height);
    // WHICH BLOCK is at H has to be settled before WHICH LOCK its witness
    // names. The tracker proves canonicality on the way into
    // CANONICAL_IMMATURE and never re-checks after that, and promotion can
    // happen at depth 0 — so a 1-block reorg immediately after our block
    // lands leaves a permanently stale row. Reading that height's witness
    // then names the REPLACEMENT miner's lock, matches his output in H+11,
    // and records his reward as ours. Both reads are internally consistent,
    // so nothing downstream notices. `blocks.block_hash` is our own recorded
    // evidence of which block we mined; disagreement is not reconcilable
    // here, it is an incident.
    if (row.block_hash && mined?.header?.hash !== row.block_hash) {
      logger.log('WALLET',
        `block ${height}: chain serves ${mined?.header?.hash || '(no block)'} but we recorded ` +
        `${row.block_hash} — NOT our block, recording nothing (NEEDS INVESTIGATION)`);
      return;
    }
    const witness = mined?.transactions?.[0]?.witnesses?.[0];
    if (!witness) { logger.log('WALLET', `block ${height}: no cellbase witness yet`); return; }

    const payout = await blockAt(payoutHeight);
    if (!payout?.transactions?.[0]) {
      logger.log('WALLET', `block ${height}: payout block ${payoutHeight} not available`);
      return;
    }

    let receipt;
    try { receipt = matchReceipt({ blockHeight: height, cellbaseWitness: witness, payoutBlock: payout }); }
    catch (e) { logger.log('WALLET', `block ${height}: ${e.message}`); return; }
    if (!receipt) { logger.log('WALLET', `block ${height}: no output pays our lock`); return; }

    const deep = tipHeight - payoutHeight >= confirmations;

    // Only the LIVE receipt is relevant: a voided row is history, and
    // migration 005 lets a fresh receipt supersede it (see below).
    const existing = (await db.query(
      `SELECT id, payout_tx_hash, confirmed_at FROM treasury_receipts
        WHERE block_id = $1 AND voided_at IS NULL`,
      [row.id])).rows[0];

    if (!existing) {
      try {
        await db.query(
          `INSERT INTO treasury_receipts
             (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
              lock_args, amount_shannons, mature_at_epoch, confirmed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() ELSE NULL END)
           ON CONFLICT (block_id) WHERE voided_at IS NULL DO NOTHING`,
          [row.id, height, receipt.payoutBlockHeight, receipt.payoutTxHash, receipt.outputIndex,
           receipt.lockArgs, receipt.amountShannons, receipt.matureAtEpoch, deep]);
      } catch (e) {
        // 23505 = unique_violation. The schema carries a SECOND unique index,
        // (payout_tx_hash, output_index) over live rows, which ON CONFLICT
        // (block_id) does not cover: two overlapping ticks can both read
        // `existing` as null and both insert. The loser must be a no-op, not an
        // exception that aborts the pass.
        if (e.code !== '23505') throw e;
        logger.log('WALLET', `block ${height}: receipt already recorded by a concurrent pass`);
        return;
      }
      logger.log('WALLET', `block ${height}: receipt ${receipt.amountShannons} shannons from ${payoutHeight}${deep ? ' (confirmed)' : ''}`);
      return;
    }

    // settled already. Unreachable from tick() — its work set excludes blocks
    // that already hold a confirmed, un-voided receipt — so this guard is
    // reached only by a direct reconcileBlock() call (an operator tool, or a
    // future caller). It is not what makes any tick() test pass.
    if (existing.confirmed_at) return;

    if (existing.payout_tx_hash !== receipt.payoutTxHash) {
      await db.query('UPDATE treasury_receipts SET voided_at = now() WHERE id = $1', [existing.id]);
      logger.log('WALLET', `block ${height}: payout block ${payoutHeight} changed — receipt VOIDED`);
      return;
    }
    if (deep) {
      await db.query('UPDATE treasury_receipts SET confirmed_at = now() WHERE id = $1', [existing.id]);
      logger.log('WALLET', `block ${height}: receipt confirmed`);
    }
  }

  async function tick() {
    const tip = await rpcClient.rpc('get_tip_header', []);
    const tipHeight = parseInt(tip?.number, 16);
    if (!Number.isFinite(tipHeight)) {
      logger.log('WALLET', `unusable tip header (number=${tip?.number}) — skipping tick`);
      return;
    }
    // A block is work until it holds a CONFIRMED, un-voided receipt. Stated
    // as NOT EXISTS rather than a LEFT JOIN filter for two reasons: a block
    // may now carry several receipt rows (voided history plus at most one
    // live row), which a join would emit repeatedly; and a block whose only
    // receipt is VOIDED must come back into the work set — otherwise one
    // ordinary reorg at H+11 strands a real reward forever (the void is
    // terminal, `voided_at` is never cleared, and no replacement could be
    // inserted). `block_hash` comes along so reconcileBlock can prove the
    // chain still serves OUR block at that height.
    const { rows } = await db.query(
      `SELECT b.id, b.height, b.block_hash FROM blocks b
        WHERE b.height IS NOT NULL
          AND b.state IN ('CANONICAL_IMMATURE','MATURE','ALLOCATED','SETTLED_TO_LEDGER')
          AND NOT EXISTS (
            SELECT 1 FROM treasury_receipts r
             WHERE r.block_id = b.id
               AND r.confirmed_at IS NOT NULL AND r.voided_at IS NULL)
        ORDER BY b.height`);
    for (const row of rows) {
      try {
        await reconcileBlock(row, tipHeight);
      } catch (e) {
        // one block's failure must not cost every later block its pass
        logger.log('WALLET', `block ${row.height}: reconcile failed: ${e.message}`);
      }
    }
  }

  return { tick, reconcileBlock };
}

module.exports.createReconciler = createReconciler;
