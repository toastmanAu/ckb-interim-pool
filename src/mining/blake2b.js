/**
 * blake2b.js — Blake2b-256 with CKB personalization "ckb-default-hash"
 *
 * Pure JS BigInt implementation. Zero dependencies.
 * RFC 7693 — output length 32 bytes, no key, personalization 16 bytes.
 */
'use strict';

const MASK64 = (1n << 64n) - 1n;

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15],
  [14,10, 4, 8, 9,15,13, 6, 1,12, 0, 2,11, 7, 5, 3],
  [11, 8,12, 0, 5, 2,15,13,10,14, 3, 6, 7, 1, 9, 4],
  [ 7, 9, 3, 1,13,12,11,14, 2, 6, 5,10, 4, 0,15, 8],
  [ 9, 0, 5, 7, 2, 4,10,15,14, 1,11,12, 6, 8, 3,13],
  [ 2,12, 6,10, 0,11, 8, 3, 4,13, 7, 5,15,14, 1, 9],
  [12, 5, 1,15,14,13, 4,10, 0, 7, 6, 3, 9, 2, 8,11],
  [13,11, 7,14,12, 1, 3, 9, 5, 0,15, 4, 8, 6, 2,10],
  [ 6,15,14, 9,11, 3, 0, 8,12, 2,13, 7, 1, 4,10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5,15,11, 9,14, 3,12,13, 0],
  [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15],
  [14,10, 4, 8, 9,15,13, 6, 1,12, 0, 2,11, 7, 5, 3],
];

function rotr64(x, n) { return ((x >> n) | (x << (64n - n))) & MASK64; }

function G(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 32n);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 24n);
  v[a] = (v[a] + v[b] + y) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 16n);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 63n);
}

/** Read 128-byte block as 16 × uint64 little-endian */
function readBlock(buf, offset) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) {
    const o = offset + i * 8;
    m[i] = BigInt(buf[o])           | (BigInt(buf[o+1]) << 8n)  |
           (BigInt(buf[o+2]) << 16n)| (BigInt(buf[o+3]) << 24n) |
           (BigInt(buf[o+4]) << 32n)| (BigInt(buf[o+5]) << 40n) |
           (BigInt(buf[o+6]) << 48n)| (BigInt(buf[o+7]) << 56n);
  }
  return m;
}

function compress(h, m, t, isLast) {
  const v = [...h, ...IV];
  v[12] ^= t & MASK64;
  v[13] ^= (t >> 64n) & MASK64;
  if (isLast) v[14] ^= MASK64;

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r];
    G(v, 0,4, 8,12, m[s[ 0]], m[s[ 1]]);
    G(v, 1,5, 9,13, m[s[ 2]], m[s[ 3]]);
    G(v, 2,6,10,14, m[s[ 4]], m[s[ 5]]);
    G(v, 3,7,11,15, m[s[ 6]], m[s[ 7]]);
    G(v, 0,5,10,15, m[s[ 8]], m[s[ 9]]);
    G(v, 1,6,11,12, m[s[10]], m[s[11]]);
    G(v, 2,7, 8,13, m[s[12]], m[s[13]]);
    G(v, 3,4, 9,14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i++) h[i] = (h[i] ^ v[i] ^ v[i+8]) & MASK64;
}

const CKB_PERSON = Buffer.alloc(16);
Buffer.from('ckb-default-hash').copy(CKB_PERSON);

/**
 * ckbBlake2b(data) → Buffer(32)
 * Blake2b-256, personalization = "ckb-default-hash", no key.
 */
function ckbBlake2b(data) {
  const outLen = 32;

  // Build 64-byte parameter block (little-endian)
  const p = Buffer.alloc(64, 0);
  p[0] = outLen;  // digest length
  p[1] = 0;       // key length
  p[2] = 1;       // fanout
  p[3] = 1;       // max depth
  // p[4..7]  leaf length = 0
  // p[8..15] node offset = 0
  // p[16]    node depth = 0
  // p[17]    inner length = 0
  // p[18..31] reserved = 0
  // p[32..47] salt = 0
  // p[48..63] personalization
  CKB_PERSON.copy(p, 48);

  // h = IV XOR parameter block (read as 8 × uint64 LE)
  const h = IV.slice();
  for (let i = 0; i < 8; i++) {
    const o = i * 8;
    let word = 0n;
    for (let k = 0; k < 8; k++) word |= BigInt(p[o + k]) << BigInt(k * 8);
    h[i] = (h[i] ^ word) & MASK64;
  }

  // Pad input to multiple of 128 bytes (at least 128)
  const inputLen = data.length;
  const padLen   = Math.max(128, Math.ceil((inputLen || 1) / 128) * 128);
  const padded   = Buffer.alloc(padLen, 0);
  Buffer.from(data).copy(padded);

  const numBlocks = padLen / 128;
  for (let b = 0; b < numBlocks; b++) {
    const isLast = b === numBlocks - 1;
    // Counter = bytes consumed so far (clamped to inputLen on last block)
    const t = isLast ? BigInt(inputLen) : BigInt((b + 1) * 128);
    compress(h, readBlock(padded, b * 128), t, isLast);
  }

  // Serialise first 32 bytes of h as LE
  const out = Buffer.allocUnsafe(32);
  for (let i = 0; i < 4; i++) {
    let w = h[i];
    for (let k = 0; k < 8; k++) { out[i*8+k] = Number(w & 0xffn); w >>= 8n; }
  }
  return out;
}

function selftest() {
  // ckbBlake2b("") == 44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e
  const got = ckbBlake2b(Buffer.alloc(0)).toString('hex');
  const exp = '44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e';
  if (got !== exp) throw new Error(`blake2b self-test FAILED\n  got: ${got}\n  exp: ${exp}`);
  return true;
}

module.exports = { ckbBlake2b, selftest };
