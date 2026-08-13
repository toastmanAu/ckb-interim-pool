'use strict';
/**
 * share-validator.js — full share evaluation with pool reject reason codes.
 *
 * Wraps the proven job-registry evaluateShare/shareDecision (ckb-stratum-proxy
 * @ 4d57892) and adds the pool classification vocabulary from spec 03 §9.
 *
 * Outcomes:
 *   accepted         → credited event (is_block_candidate possible)
 *   rejected         → LOW_DIFFICULTY (current job, below assigned target)
 *   acked_stale      → STALE_PREV_TIP (job in registry, not current) — ACK'd,
 *                      not credited (spec 03 §9: stales do not enter PPLNS)
 *   acked_unknown    → UNKNOWN_JOB (evicted/never issued) — ACK'd, no event
 *
 * A network-target solution is NEVER rejected or dropped (upstream invariant),
 * regardless of local difficulty or staleness.
 */

const { evaluateShare, shareDecision } = require('../stratum/job-registry.js');
const { targetLEToWorkUnits, workUnitsToDifficulty, workUnitsToQ } = require('../pplns/work-units.js');

const REJECT_REASON = {
  LOW_DIFFICULTY: 'LOW_DIFFICULTY',
  STALE_PREV_TIP: 'STALE_PREV_TIP',
  UNKNOWN_JOB: 'UNKNOWN_JOB',
  BAD_NONCE_FORMAT: 'BAD_NONCE_FORMAT',
  BAD_PROTOCOL: 'BAD_PROTOCOL',
  UNAUTHORIZED: 'UNAUTHORIZED',
  DUPLICATE: 'DUPLICATE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

/**
 * Evaluate a submitted nonce against the exact job the miner named.
 * @param {object} p
 * @param {string} p.family          'godminer' | 'goldshell'
 * @param {string} p.extranonce1     session extranonce1 (godminer path)
 * @param {string} p.nonceRaw        last submit param, with/without 0x
 * @param {object} p.job             resolved job snapshot or undefined
 * @param {boolean} p.isCurrentJob   true when job is the current one
 * @param {number} p.minerDiff       session's current vardiff difficulty
 * @returns {object} outcome — see module header
 */
function validateShare({ family, extranonce1, nonceRaw, job, isCurrentJob, minerDiff }) {
  if (typeof nonceRaw !== 'string' || nonceRaw.length === 0 || nonceRaw.length > 64) {
    return { outcome: 'rejected', rejectReason: REJECT_REASON.BAD_NONCE_FORMAT, isBlock: false };
  }
  if (!/^0x[0-9a-fA-F]+$/.test(nonceRaw) && !/^[0-9a-fA-F]+$/.test(nonceRaw)) {
    return { outcome: 'rejected', rejectReason: REJECT_REASON.BAD_NONCE_FORMAT, isBlock: false };
  }

  // Reconstruct the full 16-byte nonce exactly as the miner family requires.
  const { composeNonce } = require('../stratum/miner-family.js');
  const fullNonce = composeNonce(family, extranonce1, nonceRaw);
  if (fullNonce.length !== 32) {
    return { outcome: 'rejected', rejectReason: REJECT_REASON.BAD_NONCE_FORMAT, isBlock: false };
  }

  if (!job) {
    return { outcome: 'acked_unknown', rejectReason: REJECT_REASON.UNKNOWN_JOB, isBlock: false };
  }

  const v = evaluateShare(job, fullNonce, minerDiff);
  const decision = shareDecision(v, !isCurrentJob);

  if (decision.reject) {
    const hashHex = require('../mining/eaglesong.js').eaglesong(
      Buffer.concat([Buffer.from(job.powHash, 'hex'), Buffer.from(v.noncePadded, 'hex')]),
    ).toString('hex');
    return {
      outcome: 'rejected', rejectReason: REJECT_REASON.LOW_DIFFICULTY, isBlock: false,
      noncePadded: v.noncePadded, hashHex, job,
    };
  }

  // The share's work is its ASSIGNED difficulty (the vardiff target the
  // miner was solving), never the network target. Using the network target
  // inflates work by the network/assigned ratio (≈15-500x on mainnet) —
  // corrupting both hashrate estimates and PPLNS fairness. The network
  // reference work travels separately in network_difficulty_q.
  const { diffToTargetLE } = require('../mining/ckb-target.js');
  const assignedTargetLE = diffToTargetLE(minerDiff);
  const workUnits = targetLEToWorkUnits(assignedTargetLE);

  const outcome = !isCurrentJob && !v.isBlock
    ? 'acked_stale'
    : 'accepted';

  // Hash value for the durable event (validation itself ran inside evaluateShare).
  const hashHex = require('../mining/eaglesong.js').eaglesong(
    Buffer.concat([Buffer.from(job.powHash, 'hex'), Buffer.from(v.noncePadded, 'hex')]),
  ).toString('hex');

  return {
    outcome,
    rejectReason: !isCurrentJob && !v.isBlock ? REJECT_REASON.STALE_PREV_TIP : null,
    isBlock: v.isBlock,
    noncePadded: v.noncePadded,
    hashHex,
    workUnits,
    assignedDifficulty: workUnitsToDifficulty(workUnits),
    assignedDifficultyQ: workUnitsToQ(workUnits),
    minerDiff,
    job,
    status: v.status,
  };
}

/** Full 16-byte nonce (for block submission / events) — pad per family. */
function fullNonceFor(family, extranonce1, nonceRaw) {
  const { composeNonce } = require('../stratum/miner-family.js');
  return '0x' + composeNonce(family, extranonce1, nonceRaw).padStart(32, '0');
}

module.exports = { validateShare, fullNonceFor, REJECT_REASON };
