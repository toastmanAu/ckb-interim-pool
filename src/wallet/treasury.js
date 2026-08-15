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
const { ACCOUNTS } = require('../accounting/ledger.js');

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

/**
 * One treasury_snapshots row per lock we have ever received confirmed income
 * to — so treasury movement is answerable after the fact rather than
 * reconstructed.
 *
 * `total_shannons` (confirmed, un-voided treasury_receipts) and
 * `owed_shannons` (the `ACCOUNTS.CONFIRMED` ledger balance) are real
 * measurements. `spendable_shannons`/`cell_count` require enumerating the
 * treasury lock's cells through an indexer, which this plan does not have —
 * that arrives with the indexer client in a later plan. They are written
 * NULL, not 0: a stored 0 would assert "nothing is spendable", which is a
 * claim this plan cannot make and NULL (not-yet-measured) does not.
 *
 * @param {{query: Function}} db
 */
async function snapshotTreasuryLocks(db) {
  const locks = await db.query(
    `SELECT lock_args, sum(amount_shannons) AS received
       FROM treasury_receipts WHERE voided_at IS NULL AND confirmed_at IS NOT NULL
      GROUP BY lock_args`);
  const owed = (await db.query(
    `SELECT COALESCE(sum(amount_shannons), 0) AS owed FROM ledger_entries
      WHERE account_type = $1`, [ACCOUNTS.CONFIRMED])).rows[0].owed;
  for (const l of locks.rows) {
    await db.query(
      `INSERT INTO treasury_snapshots
         (lock_args, total_shannons, spendable_shannons, cell_count, owed_shannons)
       VALUES ($1, $2, NULL, NULL, $3)`,
      [l.lock_args, l.received, owed]);
  }
}

module.exports = { spendableSplit, snapshotTreasuryLocks };
