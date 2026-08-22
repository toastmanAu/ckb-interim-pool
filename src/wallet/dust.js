'use strict';
/**
 * dust.js — what "too small to pay" means on CKB, and who has stopped earning.
 *
 * A CKB output cell must carry capacity for its own serialized bytes, so a
 * payout below that floor is not merely uneconomic — it is unconstructible:
 * the transaction signs cleanly and the node rejects it with
 * -302 InsufficientCellCapacity. The floor is a property of the RECIPIENT's
 * lock (args length varies: 20 bytes for secp256k1_blake160_sighash_all, more
 * for omnilock or JoyID), never a single pool-wide constant.
 *
 * Pure: no database, no network. The worker supplies balances and timestamps.
 */

const { decodeRecipientAddress } = require('./address.js');

/** Bytes every cell pays for regardless of lock: capacity + code_hash + hash_type. */
const CELL_FIXED_BYTES = 8n + 32n + 1n;
const SHANNONS_PER_BYTE = 100_000_000n;

/**
 * Minimum capacity an output cell under `lock` may hold, in shannons.
 * Payout outputs carry no type script and no data, so occupied capacity is
 * the fixed header plus the lock args.
 *
 * @param {{args: string}} lock
 * @returns {bigint}
 */
function cellFloorShannons(lock) {
  if (!lock || typeof lock !== 'object') throw new Error('cellFloorShannons requires a lock');
  const { args } = lock;
  if (typeof args !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(args)) {
    throw new Error(`lock args must be 0x-prefixed whole bytes, got ${args}`);
  }
  const argsBytes = BigInt((args.length - 2) / 2);
  return (CELL_FIXED_BYTES + argsBytes) * SHANNONS_PER_BYTE;
}

/** The same floor, for a miner's stored payout address. */
function payableFloorForAddress(address) {
  return cellFloorShannons(decodeRecipientAddress(address));
}

/**
 * Which of the three payout regimes a confirmed balance falls into.
 *
 *   payable   — at or above the pool's payout minimum; the normal route
 *   dust      — payable as a cell, but below the minimum; needs inactivity
 *   unpayable — smaller than the recipient's own cell floor; no transaction
 *               can ever deliver it
 *
 * @returns {'payable'|'dust'|'unpayable'}
 */
function classifyBalance({ balance, floor, minimumPayout }) {
  if (balance >= minimumPayout) return 'payable';
  if (balance >= floor && balance > 0n) return 'dust';
  return 'unpayable';
}

/**
 * Refuse a payout whose recipient output could not exist on chain.
 *
 * Called before any network work so the failure is a build-time error naming
 * the miner, not a -302 InsufficientCellCapacity rejection after the signed
 * transaction has already been persisted as recovery evidence.
 *
 * Sweep targets (capacityShannons === null) are exempt: their amount is the
 * remainder computed later, and planPayoutAmounts already guards it.
 *
 * @param {Array<{address:string, capacityShannons:string|null}>} recipients
 */
function assertRecipientsPayable(recipients) {
  recipients.forEach((recipient, index) => {
    if (recipient.capacityShannons === null || recipient.capacityShannons === undefined) return;
    const amount = BigInt(recipient.capacityShannons);
    const floor = payableFloorForAddress(recipient.address);
    if (amount < floor) {
      throw new Error(
        `recipient index ${index} (${recipient.address}) would receive ${amount} shannons, ` +
        `below the minimum cell capacity ${floor} for its lock`);
    }
  });
}

module.exports = {
  cellFloorShannons,
  payableFloorForAddress,
  classifyBalance,
  assertRecipientsPayable,
  CELL_FIXED_BYTES,
  SHANNONS_PER_BYTE,
};
