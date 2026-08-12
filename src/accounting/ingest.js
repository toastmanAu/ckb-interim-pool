'use strict';
/**
 * ingest.js — central accounting ingestion: idempotent event → PostgreSQL.
 *
 * Single logical writer (spec 02 §2.3). Idempotency (decision 10):
 *   1. universal registry `ingested_events` — UNIQUE(edge_id, boot_id, edge_seq);
 *      a replayed event is a no-op;
 *   2. target rows use the same unique constraint;
 *   3. structural validation before any write (hostile edge input, spec 02 §3).
 *
 * Ordering: events are applied in arrival order; PPLNS ordering is decided
 * later by (accepted_at_ms, edge_id, boot_id, edge_seq) — not ingestion order.
 */

const crypto = require('node:crypto');
const { validate } = require('../events/validate.js');

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

async function upsertEdge(db, evt) {
  await db.query(
    `INSERT INTO edges (id, region, last_seen_at) VALUES ($1, '', now())
     ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
    [evt.edge_id],
  );
  await db.query(
    `INSERT INTO edge_boots (boot_id, edge_id, version) VALUES ($1, $2, $3)
     ON CONFLICT (boot_id) DO NOTHING`,
    [evt.edge_boot_id, evt.edge_id, 'interim-v1'],
  );
}

async function upsertMinerAndWorker(db, evt) {
  const m = await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ($1, $2)
     ON CONFLICT (payout_address) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [evt.payout_address, evt.payout_address.startsWith('ckt1') ? 'ckt' : 'ckb'],
  );
  const minerId = m.rows[0].id;
  const w = await db.query(
    `INSERT INTO workers (miner_id, worker_name) VALUES ($1, $2)
     ON CONFLICT (miner_id, worker_name) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [minerId, evt.worker],
  );
  return { minerId, workerId: w.rows[0].id };
}

async function upsertSession(db, evt, minerId, workerId) {
  await db.query(
    `INSERT INTO sessions (id, edge_id, boot_id, worker_id, last_share_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
     ON CONFLICT (id) DO UPDATE SET last_share_at = EXCLUDED.last_share_at`,
    [evt.session_id, evt.edge_id, evt.edge_boot_id, workerId, evt.accepted_at_ms],
  );
}

function insertShareEvent(db, evt, minerId, workerId) {
  return db.query(
    `INSERT INTO share_events
       (id, edge_id, boot_id, edge_seq, session_id, miner_id, worker_id,
        job_id, template_work_id, work_units, assigned_target, pow_hash,
        nonce, hash, accepted_at, is_block_candidate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_timestamp($15 / 1000.0),$16)
     ON CONFLICT (edge_id, boot_id, edge_seq) DO NOTHING`,
    [evt.event_id, evt.edge_id, evt.edge_boot_id, evt.edge_seq, evt.session_id,
     minerId, workerId, evt.job_id, evt.template_work_id, evt.work_units,
     evt.share_difficulty_q, evt.pow_hash, evt.nonce, evt.hash, evt.accepted_at_ms,
     evt.is_block_candidate],
  );
}

/** A network-target share → blocks row in CANDIDATE state (upsert). */
async function linkCandidateShare(db, evt, minerId, workerId) {
  await db.query(
    `INSERT INTO blocks (candidate_event_id, edge_id, boot_id, job_id, nonce,
                         miner_id, worker_id, state, found_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'CANDIDATE', to_timestamp($8 / 1000.0))
     ON CONFLICT (edge_id, boot_id, job_id, nonce) DO UPDATE SET
       candidate_event_id = COALESCE(blocks.candidate_event_id, EXCLUDED.candidate_event_id),
       miner_id = COALESCE(blocks.miner_id, EXCLUDED.miner_id),
       worker_id = COALESCE(blocks.worker_id, EXCLUDED.worker_id),
       found_at = COALESCE(blocks.found_at, EXCLUDED.found_at)`,
    [evt.event_id, evt.edge_id, evt.edge_boot_id, evt.job_id, evt.nonce,
     minerId, workerId, evt.accepted_at_ms],
  );
}

/** Block submission event → create or advance a blocks row. */
async function upsertBlockFromSubmit(db, evt) {
  const res = await db.query(
    `INSERT INTO blocks (candidate_event_id, edge_id, boot_id, job_id, nonce, height,
                         parent_hash, state, node_submit_result, found_at,
                         node_accepted_at, template_json)
     VALUES (NULL, $1, $2, $3, $4, $5, $6,
             CASE WHEN $7 THEN 'NODE_ACCEPTED' ELSE 'NODE_REJECTED' END,
             $8::jsonb, to_timestamp($9 / 1000.0),
             CASE WHEN $7 THEN to_timestamp($9 / 1000.0) ELSE NULL END,
             $10::jsonb)
     ON CONFLICT (edge_id, boot_id, job_id, nonce) DO UPDATE SET
       state = CASE WHEN blocks.state IN ('NODE_ACCEPTED','NODE_REJECTED') THEN blocks.state
                    ELSE EXCLUDED.state END,
       node_submit_result = EXCLUDED.node_submit_result,
       template_json = COALESCE(blocks.template_json, EXCLUDED.template_json),
       height = COALESCE(blocks.height, EXCLUDED.height),
       parent_hash = COALESCE(blocks.parent_hash, EXCLUDED.parent_hash),
       node_accepted_at = CASE WHEN EXCLUDED.state = 'NODE_ACCEPTED' AND blocks.node_accepted_at IS NULL
                               THEN EXCLUDED.node_accepted_at ELSE blocks.node_accepted_at END
     RETURNING id`,
    [evt.edge_id, evt.edge_boot_id, evt.job_id, evt.nonce, evt.height,
     evt.parent_hash, evt.submit_ok, JSON.stringify({ result: evt.node_submit_result }),
     evt.submitted_at_ms, JSON.stringify(evt.header || {})],
  );
  return res.rows[0]?.id;
}

async function recordIngested(db, evt) {
  const res = await db.query(
    `INSERT INTO ingested_events (event_id, schema, edge_id, boot_id, edge_seq, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (edge_id, boot_id, edge_seq) DO NOTHING
     RETURNING event_id`,
    [evt.event_id, evt.schema, evt.edge_id, evt.edge_boot_id, evt.edge_seq,
     sha256(JSON.stringify(evt))],
  );
  return res.rowCount > 0;   // false → already ingested
}

/**
 * Idempotent event application. Returns { status: 'applied'|'duplicate'|'invalid' }.
 */
async function processEvent(db, evt) {
  const v = validate(evt);
  if (!v.ok) return { status: 'invalid', errors: v.errors };

  const fresh = await recordIngested(db, evt);
  if (!fresh) return { status: 'duplicate' };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await upsertEdge(client, evt);
    const { minerId, workerId } = await upsertMinerAndWorker(client, evt);

    if (evt.schema === 'pool.share.accepted.v1') {
      await upsertSession(client, evt, minerId, workerId);
      await insertShareEvent(client, evt, minerId, workerId);
      if (evt.is_block_candidate) await linkCandidateShare(client, evt, minerId, workerId);
    } else if (evt.schema === 'pool.block.submit.v1') {
      await upsertBlockFromSubmit(client, evt);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { status: 'applied' };
}

/** Detect monotonic sequence gaps per (edge_id, boot_id) — advisory only. */
async function seqGaps(db, evt, onGap) {
  const r = await db.query(
    `SELECT max(edge_seq) AS max_seq FROM ingested_events WHERE edge_id = $1 AND boot_id = $2`,
    [evt.edge_id, evt.edge_boot_id],
  );
  const maxSeq = r.rows[0]?.max_seq;
  if (maxSeq !== null && evt.edge_seq > maxSeq + 1) {
    onGap?.(evt.edge_id, evt.edge_boot_id, maxSeq, evt.edge_seq);
  }
}

module.exports = { processEvent, seqGaps, upsertBlockFromSubmit, linkCandidateShare };
