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
const { payableFloorForAddress, classifyBalance } = require('./dust.js');

function createPayoutWorker({
  db,
  txBuilder,
  rpcClient = null,
  minimumPayoutShannons = '100000000000',
  maxItemsPerBatch = 200,
  limits,
  // A miner who stops earning never reaches the payout minimum again, so their
  // remaining balance is stranded. Sweep it once they have taken no credit for
  // this many days. The clock runs on credits rather than shares because
  // in-window blocks keep settling for hours after a rig stops.
  dustInactiveDays = 3,
  // Balances below the recipient's own cell floor can never be paid at all.
  // 0 disables forfeiture entirely: moving miner funds to the pool is a
  // deliberate policy act, never a default of a fresh deploy.
  forfeitAfterDays = 0,
  logger = console,
}) {
  const minimum = BigInt(minimumPayoutShannons);
  // forfeited_shannons is monotonic: it only advances on a COMMITTED forfeit.
  // There is deliberately no dust counter — dust eligibility is re-evaluated
  // every tick, so counting selections would climb while nothing was paid.
  const stats = { insolvency: 0, forfeited: 0, forfeited_shannons: 0n };

  if (minimum < 0n) throw new Error('minimumPayoutShannons must be non-negative');
  if (!Number.isInteger(maxItemsPerBatch) || maxItemsPerBatch < 1) {
    throw new Error('maxItemsPerBatch must be a positive integer');
  }
  if (!Number.isFinite(dustInactiveDays) || dustInactiveDays < 0) {
    throw new Error('dustInactiveDays must be a non-negative number of days');
  }
  if (!Number.isFinite(forfeitAfterDays) || forfeitAfterDays < 0) {
    throw new Error('forfeitAfterDays must be a non-negative number of days (0 disables)');
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

  /**
   * Every miner's confirmed balance with its payout address and the age of its
   * most recent CREDIT. A negative entry (a payout reservation) is not a
   * credit: being paid must not look like still earning, or the dust clock
   * would never expire for anyone the pool has ever paid.
   */
  async function balancesWithCreditAge() {
    const res = await db.query(
      `SELECT l.miner_id::text AS miner_id,
              m.payout_address,
              sum(l.amount_shannons)::text AS balance,
              EXTRACT(EPOCH FROM (now() - max(l.created_at)
                FILTER (WHERE l.amount_shannons > 0))) / 86400 AS credit_age_days
       FROM ledger_entries l
       JOIN miners m ON m.id = l.miner_id
       WHERE l.account_type = $1
         AND NOT EXISTS (
           SELECT 1
             FROM payout_items i
             JOIN payout_batches b ON b.id = i.batch_id
            WHERE i.miner_id = l.miner_id
              AND b.state = 'HELD'
         )
       GROUP BY l.miner_id, m.payout_address
       ORDER BY l.miner_id`,
      [ACCOUNTS.CONFIRMED],
    );
    return res.rows;
  }

  /**
   * Which regime a row falls into, or null if its address cannot be decoded.
   *
   * A balance at or above the minimum is payable without decoding anything:
   * that is the pre-dust path and it stays byte-for-byte the same, so a
   * miner who has always been paid cannot start being skipped because of a
   * change made for dust. Only a sub-minimum balance needs its lock measured.
   *
   * A malformed payout address must not throw — one bad row would stop
   * payouts for every other miner in the pool. `parseUsername` validates the
   * address at registration, so this is a guard against corrupt rows and
   * hand-edited data, not an expected path.
   */
  function classifyRow(row) {
    const balance = BigInt(row.balance);
    if (balance >= minimum) return 'payable';
    let floor;
    try {
      floor = payableFloorForAddress(row.payout_address);
    } catch (error) {
      logger.log('PAYOUT',
        `miner ${String(row.miner_id).slice(0, 8)} has an undecodable payout address ` +
        `(${error.message}); skipped`);
      return null;
    }
    return classifyBalance({ balance, floor, minimumPayout: minimum });
  }

  /**
   * Payout candidates: normal balances at or above the minimum, plus dust
   * balances whose miner has stopped earning.
   *
   * Returns rows carrying `dust` so createBatch's per-candidate re-check can
   * tell an intentional sub-minimum payout from a balance that shrank between
   * selection and construction.
   */
  async function eligibleMiners() {
    const candidates = [];
    for (const row of await balancesWithCreditAge()) {
      const regime = classifyRow(row);
      if (regime === 'payable') {
        candidates.push({ miner_id: row.miner_id, balance: row.balance, dust: false });
        continue;
      }
      if (regime !== 'dust') continue;
      const ageDays = row.credit_age_days === null ? Infinity : Number(row.credit_age_days);
      if (ageDays < dustInactiveDays) continue;
      logger.log('PAYOUT',
        `miner ${String(row.miner_id).slice(0, 8)} dust-swept: ${row.balance} shannons, ` +
        `no credit for ${ageDays.toFixed(1)} days`);
      candidates.push({ miner_id: row.miner_id, balance: row.balance, dust: true });
    }
    return candidates;
  }

  /**
   * Move balances that no transaction could ever deliver into the pool fee
   * account, after `forfeitAfterDays` of dormancy. Disabled when that is 0.
   *
   * Runs under the caller's advisory lock (single writer), and each move is
   * keyed on the ledger row it observed, so a re-run over unchanged state is a
   * no-op and a re-run after a new credit is a different key — by which point
   * the dormancy clock has reset anyway and the row no longer qualifies.
   */
  async function forfeitUnpayable() {
    if (forfeitAfterDays === 0) return [];
    const forfeited = [];
    for (const row of await balancesWithCreditAge()) {
      if (classifyRow(row) !== 'unpayable') continue;
      if (BigInt(row.balance) <= 0n) continue;
      const ageDays = row.credit_age_days === null ? Infinity : Number(row.credit_age_days);
      if (ageDays < forfeitAfterDays) continue;

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const balance = await balanceFor(client, row.miner_id, [ACCOUNTS.CONFIRMED]);
        if (balance <= 0n) { await client.query('ROLLBACK'); continue; }
        // A deterministic fingerprint of the exact confirmed-entry set observed.
        // Unchanged ledger → same key → the second post is a no-op; a new
        // credit → different key, but by then the dormancy clock has reset and
        // the row no longer qualifies. (max() has no uuid overload; cast.)
        const witness = (await client.query(
          `SELECT max(id::text) AS id FROM ledger_entries
            WHERE miner_id = $1 AND account_type = $2`,
          [row.miner_id, ACCOUNTS.CONFIRMED])).rows[0].id;
        const key = `forfeit:${row.miner_id}:${witness}`;
        const posted = await postEntry(client, {
          accountType: ACCOUNTS.CONFIRMED,
          minerId: row.miner_id,
          amountShannons: (-balance).toString(),
          referenceType: 'forfeit',
          referenceId: row.miner_id,
          idempotencyKey: key,
          metadata: { reason: 'unpayable dormant balance', ageDays, forfeitAfterDays },
        });
        if (!posted) { await client.query('ROLLBACK'); continue; }
        await postEntry(client, {
          accountType: ACCOUNTS.POOL_FEE,
          amountShannons: balance.toString(),
          referenceType: 'forfeit',
          referenceId: row.miner_id,
          idempotencyKey: `${key}:fee`,
          metadata: { minerId: row.miner_id },
        });
        await client.query('COMMIT');
        stats.forfeited++;
        stats.forfeited_shannons += balance;
        forfeited.push({ minerId: row.miner_id, amountShannons: balance.toString() });
        logger.log('PAYOUT',
          `miner ${String(row.miner_id).slice(0, 8)} forfeited ${balance} shannons to pool_fee ` +
          `(below its cell floor, dormant ${ageDays.toFixed(1)} days)`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return forfeited;
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
        // Re-checked against the ledger inside the transaction, because the
        // balance can shrink between selection and construction. A dust
        // candidate is deliberately below the minimum, so its floor is the
        // amount eligibleMiners approved rather than the payout minimum.
        const required = m.dust ? BigInt(m.balance) : minimum;
        if (owed < required) continue;
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
      await forfeitUnpayable();
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
    balancesWithCreditAge,
    forfeitUnpayable,
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
