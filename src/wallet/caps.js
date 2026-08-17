'use strict';
/**
 * Bounds for unattended payment. A breach parks the entire batch for human
 * review; auto-splitting would let a caller bypass a cap by triggering the
 * same action repeatedly.
 */

function shannons(value, field) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal shannon string`);
  }
  return BigInt(value);
}

/**
 * @param {object} options
 * @param {string} options.batchTotal
 * @param {string} options.dailySpent
 * @param {Array<{minerId:string,amount:string,owed:string}>} options.perMiner
 * @param {{maxBatchShannons:string,maxDailyShannons:string}} options.limits
 * @returns {{allowed:boolean,reason:string|null}}
 */
function capVerdict({ batchTotal, dailySpent, perMiner, limits }) {
  if (!Array.isArray(perMiner)) throw new Error('perMiner must be an array');
  if (!limits) throw new Error('payout limits are required');

  const total = shannons(batchTotal, 'batchTotal');
  const spent = shannons(dailySpent, 'dailySpent');
  const maxBatch = shannons(limits.maxBatchShannons, 'maxBatchShannons');
  const maxDaily = shannons(limits.maxDailyShannons, 'maxDailyShannons');

  let itemTotal = 0n;
  const miners = new Map();
  for (const item of perMiner) {
    if (item?.minerId == null) throw new Error('each payout item requires minerId');
    const amount = shannons(item.amount, `miner ${item.minerId} amount`);
    const owed = shannons(item.owed, `miner ${item.minerId} owed`);
    itemTotal += amount;

    const current = miners.get(String(item.minerId));
    if (current && current.owed !== owed) {
      throw new Error(`miner ${item.minerId} has inconsistent owed values in one batch`);
    }
    miners.set(String(item.minerId), {
      owed,
      amount: (current?.amount || 0n) + amount,
    });
  }

  if (itemTotal !== total) {
    return {
      allowed: false,
      reason: `batch total ${batchTotal} does not equal item sum ${itemTotal}`,
    };
  }
  for (const [minerId, miner] of miners) {
    if (miner.amount > miner.owed) {
      return {
        allowed: false,
        reason: `miner ${minerId} would be paid ${miner.amount} but is owed ${miner.owed}`,
      };
    }
  }
  if (total > maxBatch) {
    return {
      allowed: false,
      reason: `per-batch cap exceeded: ${batchTotal} > ${limits.maxBatchShannons}`,
    };
  }
  if (spent + total > maxDaily) {
    return {
      allowed: false,
      reason: `rolling 24h cap exceeded: ${dailySpent} already spent + ` +
        `${batchTotal} > ${limits.maxDailyShannons}`,
    };
  }
  return { allowed: true, reason: null };
}

/** Derive broadcast value in the rolling 24-hour window from durable rows. */
async function dailySpentShannons(db) {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(i.amount_shannons), 0) AS spent
       FROM payout_batches b
       JOIN payout_items i ON i.batch_id = b.id
      WHERE b.broadcast_at IS NOT NULL
        AND b.broadcast_at > now() - interval '24 hours'`);
  return String(rows[0].spent);
}

module.exports = { capVerdict, dailySpentShannons };
