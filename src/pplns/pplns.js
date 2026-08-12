'use strict';
/**
 * pplns.js — pure deterministic difficulty/work-weighted PPLNS engine.
 *
 * Spec 08 §6: a pure function over explicit inputs — no DB, no clocks, no
 * mutable state. The DB layer selects/orders shares; the engine computes.
 * This allows independent recomputation (operator signer, audits, tests).
 *
 * Semantics (spec 04):
 *   - window target work = (num/den) × networkWork; W defaults 2/1 (config);
 *   - walk the ordered accepted-share history BACKWARD from the winning
 *     share, including every share until cumulative work ≥ window target
 *     (the boundary-crossing share is included);
 *   - miner gross = floor(distributable × minerWork / totalWork) per share of
 *     the window; remainder distributed by the largest-remainder method with
 *     a deterministic tie-break (higher fractional remainder first, then
 *     miner key ascending);
 *   - fee = floor(reward × feeBps / 10_000), recorded separately;
 *   - conservation invariant: Σ miner credits + pool fee == reward exactly.
 *
 * All arithmetic is BigInt; reward/credits are integer shannons; work is an
 * integer string (BigInt).
 */

const crypto = require('node:crypto');

const SHARE = 10_000n;

/**
 * @param {object} input
 * @param {string} input.rewardShannons       integer shannons (BigInt string)
 * @param {number} input.feeBps               pool fee in basis points
 * @param {number} input.windowNum            window multiplier numerator (default 2)
 * @param {number} input.windowDen            window multiplier denominator (default 1)
 * @param {string} input.networkWork          network reference work (BigInt string)
 * @param {Array<{shareId:string, miner:string, workUnits:string}>} input.orderedShares
 *   shares ordered by canonical order, LAST element = winning share
 * @param {number} [input.roundingPolicyVersion=1]  1 = largest remainder
 * @returns {{
 *   allocation: Array<{miner:string, workUnits:string, creditShannons:string}>,
 *   totalWork:string, feeShannons:string, roundingShannons:string,
 *   windowStartShareId:string, windowEndShareId:string, allocationHash:string
 * }}
 */
function allocateBlock(input) {
  const reward = BigInt(input.rewardShannons);
  const feeBps = BigInt(input.feeBps);
  const winNum = BigInt(input.windowNum ?? 2);
  const winDen = BigInt(input.windowDen ?? 1);
  const networkWork = BigInt(input.networkWork);
  const shares = input.orderedShares;
  if (shares.length === 0) throw new Error('allocateBlock: no shares');

  // ── fee ───────────────────────────────────────────────────────────────────
  const feeShannons = (reward * feeBps) / SHARE;
  const distributable = reward - feeShannons;

  // ── window selection (backward from the winning share) ────────────────────
  const windowTarget = (winNum * networkWork) / winDen;
  let cumulative = 0n;
  let windowStartIdx = shares.length - 1;
  for (let i = shares.length - 1; i >= 0; i--) {
    cumulative += BigInt(shares[i].workUnits);
    windowStartIdx = i;
    if (cumulative >= windowTarget) break;
  }
  const windowShares = shares.slice(windowStartIdx);

  // ── per-miner work ────────────────────────────────────────────────────────
  const minerWork = new Map();          // miner → BigInt work
  for (const s of windowShares) {
    minerWork.set(s.miner, (minerWork.get(s.miner) || 0n) + BigInt(s.workUnits));
  }
  const totalWork = [...minerWork.values()].reduce((a, b) => a + b, 0n);

  // ── floor allocation ──────────────────────────────────────────────────────
  // miner gross = distributable × minerWork / totalWork (floor), then
  // largest-remainder distribution of the leftover shannons.
  const miners = [...minerWork.keys()].sort();
  const floors = new Map();             // miner → [work, floorShannons]
  let assigned = 0n;
  for (const m of miners) {
    const w = minerWork.get(m);
    const floor = (distributable * w) / totalWork;
    floors.set(m, { work: w, floor });
    assigned += floor;
  }
  let leftover = distributable - assigned;

  // largest remainder: order miners by (fractional remainder desc, key asc)
  const remainderOrder = miners
    .map(m => ({ m, work: floors.get(m).work, rem: ((distributable * floors.get(m).work) % totalWork) }))
    .sort((a, b) => {
      const dr = b.rem - a.rem;         // remainder desc
      if (dr !== 0n) return dr > 0n ? 1 : -1;
      return a.m < b.m ? -1 : a.m > b.m ? 1 : 0;
    });

  const credit = new Map();
  for (const m of miners) credit.set(m, floors.get(m).floor);
  for (const { m } of remainderOrder) {
    if (leftover <= 0n) break;
    credit.set(m, credit.get(m) + 1n);
    leftover -= 1n;
  }
  const roundingShannons = leftover;    // zero under policy v1

  // ── canonical output + hash ───────────────────────────────────────────────
  const allocation = miners.map(m => ({
    miner: m,
    workUnits: minerWork.get(m).toString(),
    creditShannons: credit.get(m).toString(),
  }));
  const doc = {
    allocation,
    totalWork: totalWork.toString(),
    feeShannons: feeShannons.toString(),
    roundingShannons: roundingShannons.toString(),
    windowStartShareId: windowShares[0].shareId,
    windowEndShareId: windowShares[windowShares.length - 1].shareId,
  };
  const allocationHash = crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex');

  // conservation invariant (fail loudly, never mask)
  const sumCredits = allocation.reduce((a, x) => a + BigInt(x.creditShannons), 0n);
  if (sumCredits + feeShannons + roundingShannons !== reward) {
    throw new Error(`PPLNS conservation violated: credits+fee+rounding != reward`);
  }

  return { ...doc, allocationHash };
}

module.exports = { allocateBlock };
