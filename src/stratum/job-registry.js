'use strict';
/**
 * job-registry.js — per-job snapshots + share evaluation for the solo proxy.
 *
 * Proven upstream: ckb-stratum-proxy (toastmanAu), commit 4d57892, file
 * job-registry.js. Only require paths changed for the new repo layout.
 *
 * The proxy issues a new job whenever the node's block template changes (new
 * work_id or parent). A miner solving job N may submit the result a moment
 * AFTER the proxy has advanced to job N+1. The old code validated/submitted
 * only against the *current* globals and blind-ACK'd anything else — silently
 * discarding a genuine block solved right at a job boundary.
 *
 * Fix: snapshot every job by id ({ jobId, powHash, targetLE, template }) in a
 * bounded ring, and validate a submitted share against the EXACT job it names.
 */

const { eaglesong } = require('../mining/eaglesong.js');
const { diffToTargetLE, meetsTargetLE } = require('../mining/ckb-target.js');

const DEFAULT_MAX_JOBS = 16;

/**
 * Bounded, insertion-ordered store of recent job snapshots.
 * @param {number} maxJobs  how many recent jobs to retain
 */
function createJobRegistry(maxJobs = DEFAULT_MAX_JOBS) {
  const jobs = new Map();   // jobId (int) → snapshot
  let currentId = null;

  return {
    /** Record a job snapshot and mark it current; evict the oldest past the cap. */
    add(snapshot) {
      jobs.set(snapshot.jobId, snapshot);
      currentId = snapshot.jobId;
      while (jobs.size > maxJobs) {
        jobs.delete(jobs.keys().next().value); // Map preserves insertion order → oldest first
      }
      return snapshot;
    },
    get(jobId) { return jobs.get(jobId); },
    has(jobId) { return jobs.has(jobId); },
    get current() { return currentId === null ? undefined : jobs.get(currentId); },
    get size() { return jobs.size; },
  };
}

/**
 * Evaluate a submitted nonce against a specific job snapshot.
 * Nonce byte handling mirrors the original inline logic exactly.
 * @param {object|undefined} job  snapshot { powHash, targetLE } (undefined if unknown)
 * @param {string} nonceHex       submitted nonce (with or without 0x)
 * @param {number} minerDiff      the miner's current vardiff difficulty
 * @returns {{status:'unknown_job'|'accepted'|'low_diff', isBlock:boolean, noncePadded?:string}}
 */
function evaluateShare(job, nonceHex, minerDiff) {
  if (!job || !nonceHex) return { status: 'unknown_job', isBlock: false };

  const noncePadded = nonceHex.replace(/^0x/, '').padStart(32, '0');
  const hash = eaglesong(
    Buffer.concat([Buffer.from(job.powHash, 'hex'), Buffer.from(noncePadded, 'hex')]),
  );

  const isBlock     = meetsTargetLE(hash, job.targetLE);
  const localTarget = diffToTargetLE(minerDiff);
  const meetsLocal  = !localTarget || meetsTargetLE(hash, localTarget);

  return { status: meetsLocal ? 'accepted' : 'low_diff', isBlock, noncePadded };
}

/**
 * Decide the stratum response and block action for an evaluated share.
 * Invariant: a network-target solution (isBlock) is NEVER rejected or dropped,
 * even when it fails the miner's local vardiff target — possible only when
 * vardiff exceeds network difficulty, but a block is a block.
 * @param {{status:string, isBlock:boolean}} v  result of evaluateShare
 * @param {boolean} stale  share names a job older than the current one
 * @returns {{submitBlock:boolean, reject:boolean}}
 */
function shareDecision(v, stale) {
  const submitBlock = v.isBlock === true;
  const reject = v.status === 'low_diff' && !stale && !submitBlock;
  return { submitBlock, reject };
}

module.exports = { createJobRegistry, evaluateShare, shareDecision, DEFAULT_MAX_JOBS };
