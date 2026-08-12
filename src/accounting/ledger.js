'use strict';
/**
 * ledger.js — immutable double-entry-inspired ledger (spec 04 §9).
 *
 * Every monetary mutation is an append-only ledger row with an idempotency
 * key; balances are derived views (SUM over entries). No in-place balance
 * columns. Rebuilding balances = re-summing the ledger (audit command).
 */

async function postEntry(db, { accountType, minerId = null, amountShannons, referenceType, referenceId, idempotencyKey, metadata = {} }) {
  const res = await db.query(
    `INSERT INTO ledger_entries
       (account_type, miner_id, amount_shannons, reference_type, reference_id,
        idempotency_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [accountType, minerId, amountShannons, referenceType, referenceId, idempotencyKey, JSON.stringify(metadata)],
  );
  return res.rowCount > 0;   // false = already posted (idempotent)
}

/** Derived balance for a miner over a set of account types (integer shannons). */
async function balanceFor(db, minerId, accountTypes) {
  const res = await db.query(
    `SELECT COALESCE(sum(amount_shannons), 0)::text AS balance
     FROM ledger_entries
     WHERE miner_id = $1 AND account_type = ANY($2::text[])`,
    [minerId, accountTypes],
  );
  return BigInt(res.rows[0].balance);
}

/** Full conservation check: Σ(credits) + fee == reward for a block. */
async function verifyBlockConservation(db, blockId, rewardShannons) {
  const res = await db.query(
    `SELECT COALESCE(sum(amount_shannons), 0)::text AS total
     FROM ledger_entries WHERE reference_type = 'block' AND reference_id = $1`,
    [blockId],
  );
  return BigInt(res.rows[0].total) === BigInt(rewardShannons);
}

const ACCOUNTS = {
  IMMATURE: 'miner_immature',
  CONFIRMED: 'miner_confirmed',
  PENDING_PAYOUT: 'miner_pending_payout',
  PAID: 'miner_paid',
  POOL_FEE: 'pool_fee',
  TX_FEE: 'tx_fee',
  ROUNDING: 'rounding',
  ADJUSTMENT: 'adjustment',
};

module.exports = { postEntry, balanceFor, verifyBlockConservation, ACCOUNTS };
