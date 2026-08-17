'use strict';
/** Cold-sweep policy: protect float and miner liabilities before moving value. */

const { bech32Decode, bech32Encode, validateCkbAddress } = require('../stratum/username.js');

const SIGHASH_ALL_TYPE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
const SHORT_CODE_HASHES = Object.freeze({ 0: SIGHASH_ALL_TYPE_HASH });
const HASH_TYPES = Object.freeze({ 0: 'data', 1: 'type', 2: 'data1', 4: 'data2' });

function shannons(value, field) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal shannon string`);
  }
  return BigInt(value);
}

function sweepAmount({ spendable, floatShannons, owedUnpaid }) {
  const surplus = shannons(spendable, 'spendable') -
    shannons(floatShannons, 'floatShannons') - shannons(owedUnpaid, 'owedUnpaid');
  return (surplus > 0n ? surplus : 0n).toString();
}

/** Decode a current CKB short/full address into the exact destination lock. */
function validateColdAddress(address, network = 'ckb') {
  const verdict = validateCkbAddress(address, network);
  if (!verdict.ok) {
    if (verdict.reason === 'WRONG_NETWORK') {
      throw new Error(`cold address is for network ${verdict.hrp}, not ${network}`);
    }
    throw new Error(`cold address checksum, decode, or format is invalid (${verdict.reason})`);
  }
  const decoded = bech32Decode(address);
  const roundTrip = bech32Encode(decoded.hrp, Buffer.from(decoded.data), decoded.variant);
  if (roundTrip !== address) throw new Error('cold address failed its exact round-trip check');

  if (decoded.data[0] === 0x01) {
    const codeHash = SHORT_CODE_HASHES[decoded.data[1]];
    if (!codeHash) throw new Error(`cold address uses unsupported code_hash_index ${decoded.data[1]}`);
    return {
      code_hash: codeHash,
      hash_type: 'type',
      args: '0x' + Buffer.from(decoded.data.slice(2)).toString('hex'),
    };
  }
  if (decoded.data[0] === 0x00) {
    const hashType = HASH_TYPES[decoded.data[33]];
    if (!hashType) throw new Error(`cold address has unknown hash_type ${decoded.data[33]}`);
    return {
      code_hash: '0x' + Buffer.from(decoded.data.slice(1, 33)).toString('hex'),
      hash_type: hashType,
      args: '0x' + Buffer.from(decoded.data.slice(34)).toString('hex'),
    };
  }
  throw new Error(`cold address payload type ${decoded.data[0]} is not supported for sweeps`);
}

/** Atomically record first use; concurrent different values cannot both win. */
async function checkColdAddressTofu(db, address) {
  const { rows } = await db.query(
    `INSERT INTO wallet_config (id, cold_address) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE
       SET cold_address = wallet_config.cold_address
     RETURNING cold_address`,
    [address],
  );
  const recorded = rows[0].cold_address;
  if (recorded === address) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `cold address changed from ${recorded} to ${address}; ` +
      'approve the change before any sweep',
  };
}

/** Sum each miner's positive confirmed/pending balances without double counting batch rows. */
async function owedUnpaidShannons(db, accounts) {
  if (!accounts?.CONFIRMED || !accounts?.PENDING_PAYOUT) {
    throw new Error('confirmed and pending-payout account names are required');
  }
  const { rows } = await db.query(
    `SELECT COALESCE(sum(balance), 0)::text AS owed
       FROM (
         SELECT miner_id, account_type, sum(amount_shannons) AS balance
           FROM ledger_entries
          WHERE account_type = ANY($1::text[])
          GROUP BY miner_id, account_type
         HAVING sum(amount_shannons) > 0
       ) positive_balances`,
    [[accounts.CONFIRMED, accounts.PENDING_PAYOUT]],
  );
  return rows[0].owed;
}

function createColdSweepWorker({
  db,
  txBuilder,
  coldAddress,
  treasuryLockArgs,
  floatShannons = '500000000000',
  network = 'ckb',
  rpcClient = null,
  logger = console,
}) {
  validateColdAddress(coldAddress, network);
  const protectedFloat = shannons(floatShannons, 'floatShannons');
  if (!treasuryLockArgs) throw new Error('treasuryLockArgs is required');
  if (typeof txBuilder?.buildTransfer !== 'function') {
    throw new Error('cold sweeps require a transaction builder');
  }
  const { ACCOUNTS } = require('../accounting/ledger.js');

  async function confirmSweep(sweepId, node) {
    const sweep = (await db.query(
      `SELECT state, tx_hash FROM wallet_sweeps WHERE id = $1`, [sweepId])).rows[0];
    if (!sweep || sweep.state === 'CONFIRMED') return sweep?.state === 'CONFIRMED';
    if (!['BUILT', 'BROADCAST'].includes(sweep.state) || !sweep.tx_hash) return false;
    let result;
    try {
      result = await node.rpc('get_transaction', [sweep.tx_hash]);
    } catch {
      return false;
    }
    const status = result?.tx_status?.status;
    if (status === 'pending' || status === 'proposed') {
      await db.query(
        `UPDATE wallet_sweeps
            SET state = 'BROADCAST', broadcast_at = COALESCE(broadcast_at, now())
          WHERE id = $1 AND state IN ('BUILT', 'BROADCAST')`, [sweepId]);
      return false;
    }
    if (status !== 'committed') return false;
    await db.query(
      `UPDATE wallet_sweeps SET state = 'CONFIRMED', confirmed_at = now()
        WHERE id = $1 AND state IN ('BUILT', 'BROADCAST')`, [sweepId]);
    return true;
  }

  async function recoverPendingSweeps(node) {
    const { rows } = await db.query(
      `SELECT id::text FROM wallet_sweeps
        WHERE state IN ('BUILT', 'BROADCAST') AND tx_hash IS NOT NULL
        ORDER BY created_at`);
    for (const row of rows) await confirmSweep(row.id, node);
  }

  async function runLocked() {
    if (rpcClient) await recoverPendingSweeps(rpcClient);
    const tofu = await checkColdAddressTofu(db, coldAddress);
    if (!tofu.ok) throw new Error(tofu.reason);

    const unresolved = await db.query(
      `SELECT 1 FROM wallet_sweeps WHERE state IN ('BUILT', 'BROADCAST') LIMIT 1`);
    if (unresolved.rowCount > 0) {
      logger.log('SWEEP', 'unresolved cold sweep blocks new sweep work');
      return null;
    }
    const payoutInFlight = await db.query(
      `SELECT 1 FROM payout_batches
        WHERE state IN ('RESERVED', 'BUILT', 'BROADCAST') LIMIT 1`);
    if (payoutInFlight.rowCount > 0) {
      logger.log('SWEEP', 'payout work has priority over cold sweeps');
      return null;
    }

    const snapshot = (await db.query(
      `SELECT spendable_shannons::text
         FROM treasury_snapshots
        WHERE lock_args = $1 AND spendable_shannons IS NOT NULL
        ORDER BY taken_at DESC LIMIT 1`, [treasuryLockArgs])).rows[0];
    if (!snapshot) throw new Error('no measured spendable treasury snapshot; refusing cold sweep');
    const owed = await owedUnpaidShannons(db, ACCOUNTS);
    const amount = sweepAmount({
      spendable: snapshot.spendable_shannons,
      floatShannons: protectedFloat.toString(),
      owedUnpaid: owed,
    });
    if (amount === '0') return null;

    const built = await txBuilder.buildTransfer({
      toAddress: coldAddress,
      capacityShannons: amount,
    });
    if (!built?.txHash || !built.rawTx || typeof built.broadcast !== 'function') {
      throw new Error('sweep builder must return txHash, signed rawTx, and broadcast()');
    }
    const sweep = (await db.query(
      `INSERT INTO wallet_sweeps
         (state, cold_address, amount_shannons, built_at, tx_hash, raw_tx_or_ref, fee_shannons)
       VALUES ('BUILT', $1, $2, now(), $3, $4, $5)
       RETURNING id::text`,
      [coldAddress, amount, built.txHash, JSON.stringify(built.rawTx), built.feeShannons ?? null],
    )).rows[0];

    const sent = await built.broadcast();
    if (!sent?.txHash || sent.txHash !== built.txHash) {
      throw new Error(`sweep ${sweep.id}: broadcast transaction hash mismatch`);
    }
    await db.query(
      `UPDATE wallet_sweeps SET state = 'BROADCAST', broadcast_at = now()
        WHERE id = $1 AND state = 'BUILT'`, [sweep.id]);
    logger.log('SWEEP', `cold sweep ${sweep.id.slice(0, 8)} broadcast ${amount} shannons tx=${sent.txHash}`);
    return { sweepId: sweep.id, amountShannons: amount, txHash: sent.txHash, state: 'BROADCAST' };
  }

  async function runOnce() {
    const client = await db.pool.connect();
    try {
      const acquired = (await client.query(
        'SELECT pg_try_advisory_lock(727_002) AS ok')).rows[0].ok;
      if (!acquired) return null;
      try {
        return await runLocked();
      } finally {
        await client.query('SELECT pg_advisory_unlock(727_002)');
      }
    } finally {
      client.release();
    }
  }

  return { runOnce, confirmSweep, recoverPendingSweeps };
}

module.exports = {
  sweepAmount,
  validateColdAddress,
  checkColdAddressTofu,
  owedUnpaidShannons,
  createColdSweepWorker,
};
