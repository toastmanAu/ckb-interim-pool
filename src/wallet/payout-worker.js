'use strict';
/**
 * payout-worker.js — periodic payout sweep (spec 04 §11-§12).
 *
 * State machine per batch: CREATED → BUILT → BROADCAST → CONFIRMED, with
 * explicit error/retry states. Idempotency:
 *  - one builder at a time (pg_advisory_lock);
 *  - reservation moves CONFIRMED → PENDING_PAYOUT via idempotent ledger
 *    entries (a second run cannot select already-reserved credits);
 *  - on crash after broadcast: recovery searches for the saved tx hash /
 *    signed tx on the node BEFORE constructing a replacement (never double
 *    send the same ledger amount).
 */

const { uuidv7 } = require('../common/ids.js');
const { postEntry, balanceFor, ACCOUNTS } = require('../accounting/ledger.js');
const { capVerdict, dailySpentShannons } = require('./caps.js');

function createPayoutWorker({
  db,
  txBuilder,
  rpcClient = null,
  minimumPayoutShannons = '100000000000',
  maxItemsPerBatch = 200,
  limits,
  logger = console,
}) {
  const minimum = BigInt(minimumPayoutShannons);
  const stats = { insolvency: 0 };

  if (minimum < 0n) throw new Error('minimumPayoutShannons must be non-negative');
  if (!Number.isInteger(maxItemsPerBatch) || maxItemsPerBatch < 1) {
    throw new Error('maxItemsPerBatch must be a positive integer');
  }
  if (!limits || typeof limits.maxBatchShannons !== 'string' ||
      typeof limits.maxDailyShannons !== 'string' ||
      !/^\d+$/.test(limits.maxBatchShannons) ||
      !/^\d+$/.test(limits.maxDailyShannons)) {
    throw new Error('payout limits are required as decimal shannon strings');
  }

  /** Refuse payout construction when the ledger owes more than reconciled income. */
  async function solvencyGate(queryable = db) {
    const { rows } = await queryable.query(
      `SELECT
         (SELECT COALESCE(sum(amount_shannons), 0)
            FROM treasury_receipts
           WHERE confirmed_at IS NOT NULL AND voided_at IS NULL)::text AS received,
         (SELECT COALESCE(sum(amount_shannons), 0)
            FROM ledger_entries
           WHERE account_type = ANY($1::text[]))::text AS owed`,
      [[ACCOUNTS.CONFIRMED, ACCOUNTS.PENDING_PAYOUT]],
    );
    const received = BigInt(rows[0].received);
    const owed = BigInt(rows[0].owed);
    if (owed <= received) return { ok: true, received, owed };

    stats.insolvency++;
    logger.log('INCIDENT', `INSOLVENCY: ledger owes ${owed} but reconciled income is ${received}; payouts stopped`);
    return { ok: false, received, owed };
  }

  /** Miners with confirmed balance ≥ floor, by miner id (net of reservations). */
  async function eligibleMiners() {
    const res = await db.query(
      `SELECT miner_id, sum(amount_shannons)::text AS balance
       FROM ledger_entries
       WHERE account_type = $1
         AND NOT EXISTS (
           SELECT 1
             FROM payout_items i
             JOIN payout_batches b ON b.id = i.batch_id
            WHERE i.miner_id = ledger_entries.miner_id
              AND b.state = 'HELD'
         )
       GROUP BY miner_id
       HAVING sum(amount_shannons) >= $2
       ORDER BY miner_id`,
      [ACCOUNTS.CONFIRMED, minimum.toString()],
    );
    return res.rows;
  }

  /**
   * Construct one exact proposal from current ledger balances. A cap breach
   * keeps the proposal as HELD items for audit, but posts no reservation.
   */
  async function createBatch(miners) {
    const batchId = uuidv7();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const solvent = await solvencyGate(client);
      if (!solvent.ok) {
        await client.query('ROLLBACK');
        return null;
      }

      const candidates = [];
      const seen = new Set();
      for (const m of miners.slice(0, maxItemsPerBatch)) {
        const minerId = String(m.miner_id);
        if (seen.has(minerId)) continue;
        seen.add(minerId);
        const owed = await balanceFor(client, minerId, [ACCOUNTS.CONFIRMED]);
        if (owed < minimum) continue;
        candidates.push({ minerId, amount: owed, owed });
      }
      if (candidates.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const batchTotal = candidates.reduce((sum, item) => sum + item.amount, 0n);
      const dailySpent = await dailySpentShannons(client);
      const verdict = capVerdict({
        batchTotal: batchTotal.toString(),
        dailySpent,
        perMiner: candidates.map(item => ({
          minerId: item.minerId,
          amount: item.amount.toString(),
          owed: item.owed.toString(),
        })),
        limits,
      });
      const state = verdict.allowed ? 'RESERVED' : 'HELD';

      await client.query(
        `INSERT INTO payout_batches (id, state, held_reason) VALUES ($1, $2, $3)`,
        [batchId, state, verdict.reason],
      );
      for (const item of candidates) {
        await client.query(
          `INSERT INTO payout_items (batch_id, miner_id, amount_shannons, state)
           VALUES ($1, $2, $3, $4)`,
          [batchId, item.minerId, item.amount.toString(), state],
        );
        if (state === 'RESERVED') {
          await reserveItem(client, batchId, item.minerId, item.amount);
        }
      }
      await client.query('COMMIT');
      return { batchId, items: candidates.length, state };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function reserveItem(queryable, batchId, minerId, amount) {
    await postEntry(queryable, {
      accountType: ACCOUNTS.CONFIRMED,
      minerId,
      amountShannons: (-amount).toString(),
      referenceType: 'payout',
      referenceId: batchId,
      idempotencyKey: `payout:reserve:${batchId}:${minerId}:confirmed`,
    });
    await postEntry(queryable, {
      accountType: ACCOUNTS.PENDING_PAYOUT,
      minerId,
      amountShannons: amount.toString(),
      referenceType: 'payout',
      referenceId: batchId,
      idempotencyKey: `payout:reserve:${batchId}:${minerId}:pending`,
    });
  }

  /**
   * Turn an operator-released HELD proposal into real reservations atomically.
   * The preserved amount is paid exactly; a reduced balance invalidates the
   * approval and parks the batch again for a fresh audit.
   */
  async function reserveReleasedBatch(batchId) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const batch = (await client.query(
        `SELECT state, released_by, released_at
           FROM payout_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      )).rows[0];
      if (!batch || batch.state !== 'RESERVED') {
        await client.query('ROLLBACK');
        return false;
      }

      const { rows: heldItems } = await client.query(
        `SELECT miner_id::text, amount_shannons::text
           FROM payout_items WHERE batch_id = $1 AND state = 'HELD'
          ORDER BY miner_id`,
        [batchId],
      );
      if (heldItems.length === 0) {
        await client.query('COMMIT');
        return true;
      }
      if (!batch.released_by || !batch.released_at) {
        await client.query(
          `UPDATE payout_batches SET state = 'HELD',
             held_reason = 'release rejected: missing operator audit fields'
           WHERE id = $1`,
          [batchId],
        );
        await client.query('COMMIT');
        logger.log('INCIDENT', `batch ${String(batchId).slice(0, 8)} is RESERVED without release audit fields`);
        return false;
      }
      if (!(await solvencyGate(client)).ok) {
        await client.query('ROLLBACK');
        return false;
      }

      for (const item of heldItems) {
        const amount = BigInt(item.amount_shannons);
        const confirmed = await balanceFor(client, item.miner_id, [ACCOUNTS.CONFIRMED]);
        if (confirmed < amount) {
          await client.query(
            `UPDATE payout_batches
                SET state = 'HELD', released_by = NULL, released_at = NULL,
                    held_reason = 'release invalidated: confirmed balance fell below held proposal'
              WHERE id = $1`,
            [batchId],
          );
          await client.query('COMMIT');
          logger.log('INCIDENT', `batch ${String(batchId).slice(0, 8)} release invalidated by changed balance`);
          return false;
        }
      }

      for (const item of heldItems) {
        await reserveItem(client, batchId, item.miner_id, BigInt(item.amount_shannons));
      }
      await client.query(
        `UPDATE payout_items SET state = 'RESERVED'
          WHERE batch_id = $1 AND state = 'HELD'`,
        [batchId],
      );
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Build one batch transaction, persist its signed evidence, then send. */
  async function processBatch(batchId) {
    const { rows } = await db.query(
      `SELECT i.id, i.miner_id, i.amount_shannons, m.payout_address
       FROM payout_items i
       JOIN miners m ON m.id = i.miner_id
       JOIN payout_batches b ON b.id = i.batch_id
       WHERE i.batch_id = $1 AND i.state = 'RESERVED' AND b.state = 'RESERVED'
       ORDER BY i.miner_id`,
      [batchId],
    );
    if (rows.length === 0) throw new Error(`batch ${batchId}: no items`);
    if (typeof txBuilder.buildBatchTransfer !== 'function') {
      throw new Error('crash-safe payouts require buildBatchTransfer');
    }

    const built = await txBuilder.buildBatchTransfer({
      items: rows.map(i => ({ address: i.payout_address, capacityShannons: i.amount_shannons })),
    });
    if (!built?.txHash || !built.rawTx || typeof built.broadcast !== 'function') {
      throw new Error('builder must return txHash, signed rawTx, and broadcast()');
    }
    const saved = await db.query(
      `UPDATE payout_batches
          SET state = 'BUILT', built_at = now(), tx_hash = $2,
              raw_tx_or_ref = $3, fee_shannons = $4
        WHERE id = $1 AND state = 'RESERVED'`,
      [batchId, built.txHash, JSON.stringify(built.rawTx), built.feeShannons ?? null],
    );
    if (saved.rowCount !== 1) throw new Error(`batch ${batchId}: state changed before build evidence was saved`);

    const broadcast = await built.broadcast();
    if (!broadcast?.txHash || broadcast.txHash !== built.txHash) {
      throw new Error(`batch ${batchId}: broadcast transaction hash mismatch`);
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE payout_items SET state = 'BROADCAST'
          WHERE batch_id = $1 AND state = 'RESERVED'`, [batchId]);
      await client.query(
        `UPDATE payout_batches SET state = 'BROADCAST', broadcast_at = now()
          WHERE id = $1 AND state = 'BUILT'`, [batchId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    logger.log('PAYOUT', `batch ${String(batchId).slice(0, 8)} → ${rows.length} recipients in ONE tx ${broadcast.txHash}`);
    return broadcast.txHash;
  }

  async function transactionFee(node, tx) {
    if (!tx?.inputs || !tx?.outputs) return null;
    let inputTotal = 0n;
    for (const input of tx.inputs) {
      const previous = input?.previous_output;
      if (!previous?.tx_hash) return null;
      const parent = await node.rpc('get_transaction', [previous.tx_hash]);
      const index = Number.parseInt(previous.index, 16);
      const capacity = parent?.transaction?.outputs?.[index]?.capacity;
      if (capacity == null) return null;
      inputTotal += BigInt(capacity);
    }
    const outputTotal = tx.outputs.reduce((sum, output) => sum + BigInt(output.capacity), 0n);
    if (inputTotal < outputTotal) throw new Error('payout transaction outputs exceed inputs');
    return inputTotal - outputTotal;
  }

  /** Only a committed transaction consumes the reservation and becomes PAID. */
  async function confirmBatch(batchId, node) {
    const batch = (await db.query(
      `SELECT id::text, state, tx_hash, fee_shannons::text
         FROM payout_batches WHERE id = $1`, [batchId])).rows[0];
    if (!batch || batch.state === 'CONFIRMED') return batch?.state === 'CONFIRMED';
    if (!['BUILT', 'BROADCAST'].includes(batch.state) || !batch.tx_hash) return false;

    let result;
    try {
      result = await node.rpc('get_transaction', [batch.tx_hash]);
    } catch {
      return false;
    }
    const status = result?.tx_status?.status;
    if (status === 'pending' || status === 'proposed') {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE payout_items SET state = 'BROADCAST'
            WHERE batch_id = $1 AND state = 'RESERVED'`, [batchId]);
        await client.query(
          `UPDATE payout_batches SET state = 'BROADCAST', broadcast_at = COALESCE(broadcast_at, now())
            WHERE id = $1 AND state IN ('BUILT', 'BROADCAST')`, [batchId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return false;
    }
    if (status !== 'committed') return false;

    const derivedFee = await transactionFee(node, result.transaction);
    const fee = derivedFee ?? (batch.fee_shannons == null ? null : BigInt(batch.fee_shannons));
    if (fee == null) throw new Error(`batch ${batchId}: committed transaction fee cannot be determined`);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query(
        `SELECT state FROM payout_batches WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
      if (locked?.state === 'CONFIRMED') {
        await client.query('COMMIT');
        return true;
      }
      if (!locked || !['BUILT', 'BROADCAST'].includes(locked.state)) {
        await client.query('ROLLBACK');
        return false;
      }
      const { rows: items } = await client.query(
        `SELECT miner_id::text, amount_shannons::text FROM payout_items WHERE batch_id = $1`,
        [batchId]);
      for (const item of items) {
        await postEntry(client, {
          accountType: ACCOUNTS.PAID,
          minerId: item.miner_id,
          amountShannons: item.amount_shannons,
          referenceType: 'payout',
          referenceId: batch.id,
          idempotencyKey: `payout:paid:${batch.id}:${item.miner_id}`,
          metadata: { txHash: batch.tx_hash },
        });
        await postEntry(client, {
          accountType: ACCOUNTS.PENDING_PAYOUT,
          minerId: item.miner_id,
          amountShannons: (-BigInt(item.amount_shannons)).toString(),
          referenceType: 'payout',
          referenceId: batch.id,
          idempotencyKey: `payout:paid:${batch.id}:${item.miner_id}:pending`,
        });
      }
      await postEntry(client, {
        accountType: ACCOUNTS.TX_FEE,
        amountShannons: fee.toString(),
        referenceType: 'payout',
        referenceId: batch.id,
        idempotencyKey: `payout:fee:${batch.id}`,
        metadata: { txHash: batch.tx_hash },
      });
      await client.query(
        `UPDATE payout_items SET state = 'CONFIRMED' WHERE batch_id = $1`, [batchId]);
      await client.query(
        `UPDATE payout_batches
            SET state = 'CONFIRMED', confirmed_at = now(), fee_shannons = $2
          WHERE id = $1`, [batchId, fee.toString()]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Reconcile durable hashes conservatively; never rebuild unresolved work. */
  async function recoverPendingBatches(node) {
    const { rows } = await db.query(
      `SELECT id FROM payout_batches
        WHERE state IN ('BUILT', 'BROADCAST') AND tx_hash IS NOT NULL
        ORDER BY created_at`,
    );
    for (const row of rows) {
      await confirmBatch(String(row.id), node);
    }
  }

  /** One full sweep. Returns the created batch or null. */
  async function runOnce(rpcOverride = null) {
    const [acquired] = (await db.query('SELECT pg_try_advisory_lock(727_001) AS ok')).rows;
    if (!acquired.ok) { logger.log('PAYOUT', 'another worker holds the lock'); return null; }
    try {
      const node = rpcOverride || rpcClient;
      if (node) await recoverPendingBatches(node);
      const unresolved = await db.query(
        `SELECT 1 FROM payout_batches WHERE state IN ('BUILT', 'BROADCAST') LIMIT 1`);
      if (unresolved.rowCount > 0) {
        logger.log('PAYOUT', 'unresolved signed/broadcast batch blocks new payout work');
        return null;
      }
      // resume any RESERVED batch stuck between create and process
      // (crash recovery — spec 04 §12)
      const stuck = await db.query(`SELECT id FROM payout_batches WHERE state = 'RESERVED'`);
      for (const b of stuck.rows) {
        logger.log('PAYOUT', `resuming stuck batch ${String(b.id).slice(0, 8)}`);
        if (await reserveReleasedBatch(b.id)) await processBatch(b.id);
      }
      if (stuck.rowCount > 0) return null;
      const held = await db.query(`SELECT 1 FROM payout_batches WHERE state = 'HELD' LIMIT 1`);
      if (held.rowCount > 0) return null;
      const miners = await eligibleMiners();
      if (miners.length === 0) return null;
      const batch = await createBatch(miners);
      if (batch?.state === 'RESERVED') {
        await processBatch(batch.batchId);
      }
      return batch;
    } finally {
      await db.query('SELECT pg_advisory_unlock(727_001)');
    }
  }

  return {
    runOnce,
    eligibleMiners,
    createBatch,
    processBatch,
    confirmBatch,
    recoverPendingBatches,
    reserveReleasedBatch,
    solvencyGate,
    stats,
  };
}

module.exports = { createPayoutWorker };
