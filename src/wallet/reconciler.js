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
  return {
    lockArgs: lock.args,
    payoutBlockHeight: actual,
    payoutTxHash: cellbase.hash,
    // if a cellbase ever pays our lock in several outputs, the amount is their
    // sum and the index records the first — the UNIQUE(tx,index) key still holds
    outputIndex: matches[0].index,
    amountShannons: total.toString(),
    matureAtEpoch: parseEpoch(payoutBlock.header.epoch).number + CELLBASE_MATURITY_EPOCHS,
  };
}

module.exports = { matchReceipt, REWARD_DELAY_BLOCKS, CELLBASE_MATURITY_EPOCHS };
