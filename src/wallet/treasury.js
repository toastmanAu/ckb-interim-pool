'use strict';
/**
 * treasury.js — what the pool holds, and how much of it can actually be spent.
 *
 * A pool's income is entirely cellbase outputs, which are unspendable for
 * CELLBASE_MATURITY_EPOCHS after the block that created them. Treating total
 * balance as spendable is how a payout builds a transaction the chain rejects,
 * so the split is computed explicitly and never conflated.
 */

const { CELLBASE_MATURITY_EPOCHS } = require('./reconciler.js');

/**
 * @param {object} p
 * @param {Array<{capacity:string, blockEpochNumber:number, isCellbase:boolean}>} p.cells
 * @param {number} p.tipEpochNumber
 * @returns {{total:string, spendable:string, cellCount:number}}
 */
function spendableSplit({ cells, tipEpochNumber }) {
  let total = 0n;
  let spendable = 0n;
  for (const c of cells) {
    const cap = BigInt(c.capacity);
    total += cap;
    const mature = !c.isCellbase ||
      tipEpochNumber >= c.blockEpochNumber + CELLBASE_MATURITY_EPOCHS;
    if (mature) spendable += cap;
  }
  return { total: total.toString(), spendable: spendable.toString(), cellCount: cells.length };
}

module.exports = { spendableSplit };
