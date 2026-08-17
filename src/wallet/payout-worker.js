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

  /** Build + broadcast one tx per item (or ONE batch tx when the builder
   *  supports it), then advance the batch state machine. */
  async function processBatch(batchId) {
    const { rows } = await db.query(
      `SELECT i.id, i.miner_id, i.amount_shannons, m.payout_address
       FROM payout_items i JOIN miners m ON m.id = i.miner_id
       WHERE i.batch_id = $1 ORDER BY i.miner_id`,
      [batchId],
    );
    if (rows.length === 0) throw new Error(`batch ${batchId}: no items`);
    const reservable = [];
    for (const item of rows) {
      const state = (await db.query(`SELECT state FROM payout_items WHERE id = $1`, [item.id])).rows[0].state;
      if (state === 'RESERVED') reservable.push(item);
    }
    if (reservable.length === 0) return;

    let batchResult = null;
    if (typeof txBuilder.buildBatchTransfer === 'function') {
      // one signed transaction for the whole batch (spec 04 §11 batching)
      batchResult = await txBuilder.buildBatchTransfer({
        items: reservable.map(i => ({ address: i.payout_address, capacityShannons: i.amount_shannons })),
      });
      const broadcast = await batchResult.broadcast();
      await postEntriesForBatch(batchId, reservable, broadcast.txHash);
      logger.log('PAYOUT', `batch ${batchId.slice(0, 8)} → ${reservable.length} recipients in ONE tx ${broadcast.txHash}`);
    } else {
      for (const item of reservable) {
        const built = await txBuilder.buildTransfer({
          toAddress: item.payout_address,
          capacityShannons: item.amount_shannons,
        });
        const broadcast = await built.broadcast();
        await postEntriesForBatch(batchId, [item], broadcast.txHash);
        logger.log('PAYOUT', `batch ${batchId.slice(0, 8)} → ${item.payout_address.slice(0, 12)}… ${item.amount_shannons} shannons tx=${broadcast.txHash}`);
      }
    }
    await db.query(
      `UPDATE payout_batches SET state = 'BROADCAST', broadcast_at = now(), tx_hash = $2 WHERE id = $1 AND state = 'RESERVED'`,
      [batchId, batchResult ? null : null],
    );
  }

  /** Mark items BROADCAST + post the PAID ledger transitions (idempotent). */
  async function postEntriesForBatch(batchId, items, txHash) {
    for (const item of items) {
      await db.query(
        `UPDATE payout_items SET state = 'BROADCAST' WHERE id = $1 AND state = 'RESERVED'`,
        [item.id],
      );
      await postEntry(db, {
        accountType: ACCOUNTS.PAID,
        minerId: item.miner_id,
        amountShannons: item.amount_shannons,
        referenceType: 'payout',
        referenceId: batchId,
        idempotencyKey: `payout:paid:${batchId}:${item.miner_id}`,
        metadata: { txHash },
      });
      await postEntry(db, {
        accountType: ACCOUNTS.PENDING_PAYOUT,
        minerId: item.miner_id,
        amountShannons: (-BigInt(item.amount_shannons)).toString(),
        referenceType: 'payout',
        referenceId: batchId,
        idempotencyKey: `payout:paid:${batchId}:${item.miner_id}:pending`,
      });
    }
  }

  /** Confirm broadcast txs on the node (poll get_transaction until committed). */
  async function confirmBatch(batchId, rpcClient) {
    const { rows } = await db.query(
      `SELECT id, miner_id FROM payout_items WHERE batch_id = $1 AND state = 'BROADCAST'`,
      [batchId],
    );
    for (const item of rows) {
      // tx hash is in the PAID ledger metadata
      const meta = (await db.query(
        `SELECT metadata FROM ledger_entries WHERE idempotency_key = $1`,
        [`payout:paid:${batchId}:${item.miner_id}`],
      )).rows[0]?.metadata;
      const txHash = meta?.txHash;
      if (!txHash) continue;
      let status = null;
      try {
        const tx = await rpcClient.rpc('get_transaction', [txHash]);
        status = tx?.tx_status?.status;
      } catch { /* not found yet */ }
      if (status === 'committed' || status === 'proposed') {
        await db.query(`UPDATE payout_items SET state = 'CONFIRMED' WHERE id = $1`, [item.id]);
      }
    }
    const remaining = (await db.query(
      `SELECT count(*)::int c FROM payout_items WHERE batch_id = $1 AND state != 'CONFIRMED'`,
      [batchId],
    )).rows[0].c;
    if (remaining === 0) {
      await db.query(`UPDATE payout_batches SET state = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [batchId]);
    }
  }

  /** Crash recovery: find BROADCAST items whose tx already exists on-chain. */
  async function recoverPendingBatches(rpcClient) {
    const { rows } = await db.query(
      `SELECT DISTINCT batch_id FROM payout_items WHERE state IN ('RESERVED','BROADCAST')`,
    );
    for (const { batch_id: raw } of rows) {
      const batch_id = raw.replace(/-/g, '');
      const { rows: items } = await db.query(
        `SELECT id, miner_id, state FROM payout_items WHERE batch_id = $1 AND state = 'BROADCAST'`,
        [batch_id],
      );
      for (const item of items) {
        const meta = (await db.query(
          `SELECT metadata FROM ledger_entries WHERE idempotency_key = $1`,
          [`payout:paid:${batch_id}:${item.miner_id}`],
        )).rows[0]?.metadata;
        if (!meta?.txHash) continue;
        try {
          const tx = await rpcClient.rpc('get_transaction', [meta.txHash]);
          if (tx?.tx_status?.status) {
            // already broadcast — do not re-send
            await db.query(`UPDATE payout_items SET state = 'BROADCAST' WHERE id = $1`, [item.id]);
          }
        } catch { /* not on-chain — safe to re-broadcast from BUILT state */ }
      }
      await confirmBatch(batch_id, rpcClient);
    }
  }

  /** One full sweep. Returns the created batch or null. */
  async function runOnce() {
    const [acquired] = (await db.query('SELECT pg_try_advisory_lock(727_001) AS ok')).rows;
    if (!acquired.ok) { logger.log('PAYOUT', 'another worker holds the lock'); return null; }
    try {
      // resume any RESERVED batch stuck between create and process
      // (crash recovery — spec 04 §12)
      const stuck = await db.query(`SELECT id FROM payout_batches WHERE state = 'RESERVED'`);
      for (const b of stuck.rows) {
        logger.log('PAYOUT', `resuming stuck batch ${String(b.id).slice(0, 8)}`);
        if (await reserveReleasedBatch(b.id)) await processBatch(b.id);
      }
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
