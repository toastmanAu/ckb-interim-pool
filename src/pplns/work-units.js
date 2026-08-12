'use strict';
/**
 * work-units.js — canonical integer work representation for shares.
 *
 * Decision 14 + spec 03 §11: PPLNS and accounting never sum floating-point
 * difficulty. A share's expected hash work is measured by its target:
 *
 *   work_units = floor((2^256 - 1) / target)
 *
 * (the mean number of hashes needed to find a hash ≤ target, exactly —
 * the standard "expected work" metric). Industry diff=1 corresponds to
 * target = 2^224 → work_units = 2^32 - 1 ≈ 2^32 hashes.
 *
 * Determinism: work_units is derived from the exact assigned target (a
 * 64-char LE hex string) — the same input always yields the same integer,
 * in any language, without rounding.
 *
 * Display difficulty is derived ONLY for the UI:
 *   difficulty = work_units / 2^32   (as an exact decimal string)
 */

const MASK256 = (1n << 256n) - 1n;
const HASHES_PER_DIFF1 = 1n << 32n;

/** work_units for a 64-char LE hex target. */
function targetLEToWorkUnits(targetLE) {
  let be = '';
  for (let i = 62; i >= 0; i -= 2) be += targetLE.slice(i, i + 2);
  return MASK256 / BigInt('0x' + be);
}

/** work_units from a raw bigint target. */
function targetBigIntToWorkUnits(targetBigInt) {
  if (targetBigInt <= 0n) return 0n;
  return MASK256 / targetBigInt;
}

/**
 * Exact decimal string of work_units / 2^32 (UI display only; never summed).
 */
function workUnitsToDifficulty(workUnits) {
  const whole = workUnits / HASHES_PER_DIFF1;
  const frac = (workUnits % HASHES_PER_DIFF1) * 1000000000000n / HASHES_PER_DIFF1;
  const fracStr = frac.toString(10).padStart(12, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

/** Canonical rational form "num/den" used on the wire (spec §10 _q fields). */
function workUnitsToQ(workUnits) {
  return `${workUnits}/${HASHES_PER_DIFF1}`;
}

module.exports = {
  MASK256, HASHES_PER_DIFF1,
  targetLEToWorkUnits,
  targetBigIntToWorkUnits,
  workUnitsToDifficulty,
  workUnitsToQ,
};
