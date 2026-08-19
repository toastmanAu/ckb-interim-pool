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
 * CKB measures cellbase maturity on the full EpochNumberWithFraction
 * (number + index/length), not the integer epoch number — the same convention
 * `reconciler.js` follows when it records `mature_at_epoch`. Comparing only
 * the integer part reports maturity up to a whole epoch EARLY, and a spend
 * gated on that is rejected by the node as immature. This module and the
 * reconciler must not disagree about when money can move.
 *
 * @param {{number:number, index:number, length:number}} e
 */
function checkEpoch(e, what) {
  if (!e || !Number.isInteger(e.number) || !Number.isInteger(e.index) || !Number.isInteger(e.length)) {
    throw new Error(`${what} must be {number, index, length} (an EpochNumberWithFraction)`);
  }
  // length 0 would make the fraction meaningless; guessing a value here would
  // be guessing about spendability
  if (e.length <= 0) throw new Error(`${what}.length must be positive, got ${e.length}`);
  return e;
}

/** a >= b, comparing the full fraction exactly (no floating point). */
function epochAtLeast(a, b) {
  if (a.number !== b.number) return a.number > b.number;
  return BigInt(a.index) * BigInt(b.length) >= BigInt(b.index) * BigInt(a.length);
}

/**
 * @param {object} p
 * @param {Array<{capacity:string, blockEpoch:{number:number,index:number,length:number},
 *                isCellbase:boolean}>} p.cells
 * @param {{number:number, index:number, length:number}} p.tipEpoch
 * @returns {{total:string, spendable:string, cellCount:number}}
 */
function spendableSplit({ cells, tipEpoch }) {
  const tip = checkEpoch(tipEpoch, 'tipEpoch');
  let total = 0n;
  let spendable = 0n;
  for (const c of cells) {
    const cap = BigInt(c.capacity);
    total += cap;
    let mature = true;
    if (c.isCellbase) {
      const be = checkEpoch(c.blockEpoch, 'blockEpoch');
      // maturity carries the block's own fraction forward: a cell created
      // halfway through epoch N is spendable halfway through epoch N+4
      mature = epochAtLeast(tip,
        { number: be.number + CELLBASE_MATURITY_EPOCHS, index: be.index, length: be.length });
    }
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
 * `owed_shannons` (the `ACCOUNTS.CONFIRMED` ledger balance) come from durable
 * accounting data. When indexer measurement inputs are supplied, live cells
 * provide `spendable_shannons` and `cell_count`; without them those fields are
 * NULL, never a false zero.
 *
 * @param {{query: Function}} db
 * @param {object} [measurement]
 * @param {string} measurement.indexerUrl
 * @param {string} [measurement.nodeUrl]
 * @param {Function} measurement.rpc
 * @param {string} measurement.tipEpochHex
 * @param {{code_hash:string,hash_type:string,args:string}} measurement.lock
 */
async function snapshotTreasuryLocks(db, measurement = {}) {
  const { indexerUrl, nodeUrl, rpc, tipEpochHex, lock } = measurement;
  const supplied = [indexerUrl, rpc, tipEpochHex, lock].filter(value => value != null).length;
  if (supplied > 0 && supplied < 4) {
    throw new Error('measured treasury snapshot requires indexerUrl, rpc, tipEpochHex and lock');
  }
  const canMeasure = supplied === 4;
  const locks = await db.query(
    `SELECT lock_args, sum(amount_shannons) AS received
       FROM treasury_receipts WHERE voided_at IS NULL AND confirmed_at IS NOT NULL
      GROUP BY lock_args`);
  // A bootstrapped treasury is funded by TRANSFER before it has mined
  // anything: no receipts, so no row in the query above. The keystore lock
  // must still be measured every tick, or the sweep pass fails forever on
  // "no measured spendable treasury snapshot" — the money is real and
  // spendable, just not mining income.
  if (canMeasure && !locks.rows.some(l => l.lock_args === lock.args)) {
    // total_shannons is NOT NULL: a lock with zero confirmed receipts has,
    // as a measured fact of the database, received 0 via mining.
    locks.rows.push({ lock_args: lock.args, received: '0' });
  }
  const owed = (await db.query(
    `SELECT COALESCE(sum(amount_shannons), 0) AS owed FROM ledger_entries
      WHERE account_type = $1`, [ACCOUNTS.CONFIRMED])).rows[0].owed;
  for (const l of locks.rows) {
    let spendable = null;
    let cellCount = null;
    if (canMeasure && l.lock_args === lock.args) {
      // Lazy to avoid a module cycle at initialization: cells.js consumes
      // spendableSplit from this module. Only the lock derived from the loaded
      // key is measured: reporting an old receipt lock as spendable would
      // claim the current wallet can sign for money it does not control.
      const { collectLiveCells, treasuryView } = require('./cells.js');
      const rawCells = await collectLiveCells({ indexerUrl, nodeUrl, lock, rpc });
      const view = treasuryView({ rawCells, tipEpochHex });
      spendable = view.spendable;
      cellCount = view.cellCount;
    }
    await db.query(
      `INSERT INTO treasury_snapshots
         (lock_args, total_shannons, spendable_shannons, cell_count, owed_shannons)
       VALUES ($1, $2, $3, $4, $5)`,
      [l.lock_args, l.received, spendable, cellCount, owed]);
  }
}

module.exports = { spendableSplit, snapshotTreasuryLocks, epochAtLeast };
