'use strict';
/**
 * ckb-target.js — target / difficulty helpers for CKB stratum.
 *
 * Targets are carried as 64-char little-endian hex (matching the byte order of
 * the Eaglesong hash output), so comparison is a byte-wise walk from the most
 * significant end. Extracted from solo-proxy.js so the share-evaluation logic
 * (job-registry.js) can use it without booting the server.
 */

const MASK256 = (1n << 256n) - 1n;

// Standard CKB stratum diff=1 reference: 2^224 (≈ 2^32 hashes per share).
const DIFF1_TARGET = (1n << 224n);

/** Decode a compact target (nBits-style) to 64-char LE hex. */
function compactToTargetLE(compact) {
  const c   = BigInt(compact);
  const exp = c >> 24n;
  const man = c & 0xffffffn;
  let n = (exp <= 3n) ? (man >> (8n * (3n - exp))) : (man << (8n * (exp - 3n)));
  if (n > MASK256) n = MASK256;
  return bigIntToHexLE(n);
}

/** Scale diff=1 target down by `diff` → 64-char LE hex. */
function diffToTargetLE(diff) {
  if (diff <= 0) return bigIntToHexLE(DIFF1_TARGET);
  const diffBig = BigInt(Math.round(diff * 1_000_000));
  let local = (DIFF1_TARGET * 1_000_000n) / diffBig;
  if (local > MASK256) local = MASK256;
  return bigIntToHexLE(local);
}

function hexLEToBigInt(hex) {
  let be = ''; for (let i = 62; i >= 0; i -= 2) be += hex.slice(i, i + 2);
  return BigInt('0x' + be);
}

function bigIntToHexLE(n) {
  if (n <= 0n) return '0'.repeat(64);
  if (n > MASK256) n = MASK256;
  const be = n.toString(16).padStart(64, '0');
  let le = ''; for (let i = 62; i >= 0; i -= 2) le += be.slice(i, i + 2);
  return le;
}

/**
 * True if the Eaglesong hash <= target.
 * hashBuf is the raw Eaglesong output: byte 0 is the HIGH-order byte — CKB
 * consensus compares it as U256::from_big_endian. targetHex is stored LE by
 * this proxy's convention, so we walk the hash MSB-first (byte 0) against the
 * target's MSB (its last byte).
 */
function meetsTargetLE(hashBuf, targetHex) {
  const tLE = Buffer.from(targetHex, 'hex');
  for (let i = 0; i < 32; i++) {
    const tByte = tLE[31 - i];
    if (hashBuf[i] < tByte) return true;
    if (hashBuf[i] > tByte) return false;
  }
  return true; // exactly equal counts as meeting the target
}

module.exports = {
  MASK256, DIFF1_TARGET,
  compactToTargetLE, diffToTargetLE, meetsTargetLE, hexLEToBigInt, bigIntToHexLE,
};
