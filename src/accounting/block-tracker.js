'use strict';
/**
 * block-tracker.js — canonical block lifecycle for the accounting service.
 *
 * Polls the trusted node and advances `blocks` rows:
 *
 *   NODE_ACCEPTED → CANONICAL_IMMATURE    (block hash at height == ours)
 *                 → ORPHANED              (a DIFFERENT block sits at our
 *                                          height and the chain has built
 *                                          `orphanConfirmations` past it)
 *   CANONICAL_IMMATURE → MATURE           (tip epoch ≥ found epoch + maturityEpochs)
 *   ORPHANED → CANONICAL_IMMATURE         (verdict was wrong; still within
 *                                          `orphanRecheckDepth` of the tip)
 *
 * Orphan-verdict rule (incident 2026-08-14): an orphan must be proven
 * POSITIVELY — our hash absent from a height the chain has since built past.
 * Everything else (a lookup that failed, a block the node has not indexed, a
 * height at the very tip, a row with no stored template) is "cannot tell
 * yet", NOT "lost". Two won mainnet blocks were written off as orphans
 * because a stale build recomputed the wrong candidate hash and the tracker
 * read one mismatch, at zero confirmations, as proof — then never looked
 * again. Both blocks were canonical the whole time.
 *
 * Verification basis (all chain-derived, nothing hard-coded):
 *  - candidate block hash = ckb_blake2b(serializeFullHeader(fields, nonce)),
 *    pinned byte-for-byte against a real mainnet block (test/ckb-template.test.js);
 *  - canonical check: get_block_by_number(height).header.hash == candidate hash;
 *  - reward: sum of the canonical cellbase outputs (shannons) — never a constant;
 *  - maturity: CELLBASE_MATURITY = 4 epochs (verified against CKB source
 *    spec/src/consensus.rs). Epoch comparison uses the integer epoch number
 *    (conservative: may delay maturity, never advance it).
 */

const { ckbBlake2b } = require('../mining/blake2b.js');
const { serializeFullHeader, parseEpoch } = require('../mining/ckb-header.js');

function candidateBlockHash(headerFields, nonceHex) {
  const h = headerFields;
  // the node serializes the header nonce as a u128 value in LE — mirror the
  // submission form (see src/edge/block-submitter.js) so the recomputed
  // hash matches what the node stores
  const { minimalNonceHex } = require('../edge/block-submitter.js');
  return ckbBlake2b(serializeFullHeader({
    version: h.version,
    compact_target: h.compact_target,
    timestamp: h.current_time,
    number: h.number,
    epoch: h.epoch,
    parent_hash: h.parent_hash,
    transactions_root: h.transactions_root,
    proposals_hash: h.proposals_hash,
    extra_hash: h.extra_hash,
    dao: h.dao,
  }, minimalNonceHex(nonceHex))).toString('hex');
}

function createBlockTracker({
  db, rpcClient, maturityEpochs = 4, logger = console, intervalMs = 5000,
  // confirmations the chain must build past our height before a mismatch is
  // read as an orphan (CKB reorgs are shallow; 3 is well past the noise)
  orphanConfirmations = 3,
  // how far back an ORPHANED verdict stays open to correction. Past this the
  // chain cannot reorg, so re-polling every orphan forever is pure waste;
  // older mistakes are repaired by hand, deliberately.
  orphanRecheckDepth = 1000,
} = {}) {
  let timer = null;
  let stopped = false;

  async function tipHeader() {
    return rpcClient.rpc('get_tip_header', []);
  }

  async function blockAtHeight(height) {
    return rpcClient.rpc('get_block_by_number', [`0x${BigInt(height).toString(16)}`]);
  }

  async function tick() {
    const { rows } = await db.query(
      `SELECT id, nonce, height, state, template_json, block_epoch_json
       FROM blocks WHERE state IN ('NODE_ACCEPTED', 'CANONICAL_IMMATURE', 'ORPHANED')`,
    );
    if (rows.length === 0) return;

    const tip = await tipHeader();
    const tipHeight = parseInt(tip.number, 16);
    const tipEpoch = parseEpoch(tip.epoch);
    if (!Number.isFinite(tipHeight)) {
      // a NaN tip silently disables every depth guard below — refuse to run
      logger.log('BLOCK', `unusable tip header (number=${tip?.number}) — skipping tick`);
      return;
    }

    for (const b of rows) {
      const height = parseInt(b.height, 10);
      if (height > tipHeight) continue;   // not reached yet

      const depth = tipHeight - height;   // confirmations built past our height

      // a verdict older than any possible reorg is final; re-polling every
      // orphan forever is unbounded work for no new information
      if (b.state === 'ORPHANED' && depth > orphanRecheckDepth) continue;

      let canonical = null;
      try {
        canonical = await blockAtHeight(height);
      } catch (e) {
        logger.log('BLOCK', `get_block_by_number(${height}) failed: ${e.message}`);
        continue;
      }
      const canonicalHash = (canonical?.header?.hash || '').replace(/^0x/, '');
      if (!canonicalHash) {
        // the node has no block indexed at that height yet: missing evidence,
        // not evidence of loss
        logger.log('BLOCK', `no block at height ${height} yet — deferring verdict`);
        continue;
      }

      if (b.state === 'NODE_ACCEPTED' || b.state === 'ORPHANED') {
        const template = typeof b.template_json === 'string' ? JSON.parse(b.template_json) : (b.template_json || {});
        if (!template || !template.compact_target) {
          // without the submitted header we cannot recompute our own hash, so
          // we can never prove canonicality OR loss — never guess
          logger.log('BLOCK', `block ${height} has no template_json — cannot verify (needs investigation)`);
          continue;
        }
        const candidate = candidateBlockHash(template, b.nonce);
        if (candidate === canonicalHash) {
          const cellbase = canonical.transactions?.[0];
          let reward = 0n;
          if (cellbase?.outputs) {
            for (const out of cellbase.outputs) reward += BigInt(out.capacity);
          }
          const blockEpochHex = canonical.header.epoch;
          const blockEpoch = parseEpoch(blockEpochHex);
          const mature = tipEpoch.number >= blockEpoch.number + maturityEpochs;
          await db.query(
            `UPDATE blocks SET state = $1, block_hash = $2, reward_shannons = $3,
               block_epoch_json = $4,
               node_accepted_at = COALESCE(node_accepted_at, now()),
               matured_at = CASE WHEN $5 THEN now() ELSE matured_at END,
               orphaned_at = NULL
             WHERE id = $6`,
            [mature ? 'MATURE' : 'CANONICAL_IMMATURE', '0x' + canonicalHash,
             reward.toString(), blockEpochHex, mature, b.id],
          );
          if (b.state === 'ORPHANED') {
            logger.log('BLOCK', `block ${height} RESTORED from ORPHANED — it is canonical (${canonicalHash.slice(0, 16)}…) reward=${reward}`);
          } else {
            logger.log('BLOCK', `block ${height} canonical (${canonicalHash.slice(0, 16)}…) reward=${reward} ${mature ? 'MATURE' : 'immature'}`);
          }
        } else if (b.state === 'ORPHANED') {
          // still absent from the chain — verdict stands, nothing to write
        } else if (depth >= orphanConfirmations) {
          await db.query(`UPDATE blocks SET state = 'ORPHANED', orphaned_at = now() WHERE id = $1`, [b.id]);
          logger.log('BLOCK', `block ${height} ORPHANED — canonical is ${canonicalHash.slice(0, 16)}…, ours ${candidate.slice(0, 16)}… at depth ${depth}`);
        } else {
          // mismatch, but the chain has not built far enough past us to call
          // it: stay NODE_ACCEPTED and look again next tick
          logger.log('BLOCK', `block ${height} unconfirmed at depth ${depth}/${orphanConfirmations} — verdict deferred`);
        }
      } else if (b.state === 'CANONICAL_IMMATURE') {
        const blockEpoch = parseEpoch(b.block_epoch_json || '0x0');
        const mature = tipEpoch.number >= blockEpoch.number + maturityEpochs;
        if (mature) {
          await db.query(`UPDATE blocks SET state = 'MATURE', matured_at = now() WHERE id = $1`, [b.id]);
          logger.log('BLOCK', `block ${height} MATURE`);
        }
      }
    }
  }

  function start() {
    timer = setInterval(async () => {
      if (stopped) return;
      try { await tick(); }
      catch (e) { logger.log('BLOCK', `tracker tick failed: ${e.message}`); }
    }, intervalMs);
    timer.unref();
    return this;
  }

  function stop() { stopped = true; clearInterval(timer); }

  return { tick, start, stop, candidateBlockHash };
}

module.exports = { createBlockTracker, candidateBlockHash };
