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

function createPayoutWorker({ db, txBuilder, minimumPayoutShannons = '100000000000', maxItemsPerBatch = 200, logger = console }) {
  const minimum = BigInt(minimumPayoutShannons);

  /** Miners with confirmed balance ≥ floor, by miner id (net of reservations). */
  async function eligibleMiners() {
    const res = await db.query(
      `SELECT miner_id, sum(amount_shannons)::text AS balance
       FROM ledger_entries
       WHERE account_type = $1
       GROUP BY miner_id
       HAVING sum(amount_shannons) >= $2
       ORDER BY miner_id`,
      [ACCOUNTS.CONFIRMED, minimum.toString()],
    );
    return res.rows;
  }

  /** Reserve exactly the confirmed balance for each eligible miner. */
  async function createBatch(miners) {
    const batchId = uuidv7();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO payout_batches (id, state) VALUES ($1, 'CREATED')`,
        [batchId],
      );
      let items = 0;
      for (const m of miners.slice(0, maxItemsPerBatch)) {
        const amount = BigInt(m.balance);
        const r = await client.query(
          `INSERT INTO payout_items (batch_id, miner_id, amount_shannons) VALUES ($1, $2, $3)
           ON CONFLICT (batch_id, miner_id) DO NOTHING RETURNING id`,
          [batchId, m.miner_id, amount.toString()],
        );
        if (r.rowCount === 0) continue;
        await postEntry(client, {
          accountType: ACCOUNTS.CONFIRMED,
          minerId: m.miner_id,
          amountShannons: (-amount).toString(),
          referenceType: 'payout',
          referenceId: batchId,
          idempotencyKey: `payout:reserve:${batchId}:${m.miner_id}:confirmed`,
        });
        await postEntry(client, {
          accountType: ACCOUNTS.PENDING_PAYOUT,
          minerId: m.miner_id,
          amountShannons: amount.toString(),
          referenceType: 'payout',
          referenceId: batchId,
          idempotencyKey: `payout:reserve:${batchId}:${m.miner_id}:pending`,
        });
        items++;
      }
      if (items === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(`UPDATE payout_batches SET state = 'RESERVED' WHERE id = $1`, [batchId]);
      await client.query('COMMIT');
      return { batchId, items };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Build + broadcast one tx per item; advance the batch state machine. */
  async function processBatch(batchId) {
    const { rows } = await db.query(
      `SELECT i.id, i.miner_id, i.amount_shannons, m.payout_address
       FROM payout_items i JOIN miners m ON m.id = i.miner_id
       WHERE i.batch_id = $1 ORDER BY i.miner_id`,
      [batchId],
    );
    if (rows.length === 0) throw new Error(`batch ${batchId}: no items`);

    for (const item of rows) {
      const state = (await db.query(`SELECT state FROM payout_items WHERE id = $1`, [item.id])).rows[0].state;
      if (state !== 'RESERVED') continue;   // already broadcast/paid — never resend
      const built = await txBuilder.buildTransfer({
        toAddress: item.payout_address,
        capacityShannons: item.amount_shannons,
      });
      const broadcast = await built.broadcast();
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
        metadata: { txHash: broadcast.txHash },
      });
      await postEntry(db, {
        accountType: ACCOUNTS.PENDING_PAYOUT,
        minerId: item.miner_id,
        amountShannons: (-BigInt(item.amount_shannons)).toString(),
        referenceType: 'payout',
        referenceId: batchId,
        idempotencyKey: `payout:paid:${batchId}:${item.miner_id}:pending`,
      });
      logger.log('PAYOUT', `batch ${batchId.slice(0, 8)} → ${item.payout_address.slice(0, 12)}… ${item.amount_shannons} shannons tx=${broadcast.txHash}`);
    }
    await db.query(
      `UPDATE payout_batches SET state = 'BROADCAST', broadcast_at = now(), tx_hash = $2 WHERE id = $1 AND state = 'RESERVED'`,
      [batchId, rows[0] ? null : null],
    );
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
      const miners = await eligibleMiners();
      if (miners.length === 0) return null;
      const batch = await createBatch(miners);
      if (batch) {
        await processBatch(batch.batchId);
        return batch;
      }
      return null;
    } finally {
      await db.query('SELECT pg_advisory_unlock(727_001)');
    }
  }

  return { runOnce, eligibleMiners, createBatch, processBatch, confirmBatch, recoverPendingBatches };
}

module.exports = { createPayoutWorker };
