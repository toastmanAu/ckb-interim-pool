'use strict';
/**
 * ckb-target.test.js — characterization tests for the target/difficulty helpers
 * (extracted from solo-proxy.js so job-registry.js can use them in isolation).
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  compactToTargetLE, diffToTargetLE, meetsTargetLE, hexLEToBigInt, bigIntToHexLE, DIFF1_TARGET,
} = require('../src/mining/ckb-target.js');

test('diff=1 maps to the 2^224 reference target', () => {
  assert.strictEqual(DIFF1_TARGET, 1n << 224n);
  assert.strictEqual(hexLEToBigInt(diffToTargetLE(1)), 1n << 224n);
});

test('higher difficulty means a smaller (harder) target', () => {
  assert.strictEqual(hexLEToBigInt(diffToTargetLE(4)), (1n << 224n) / 4n);
});

test('bigIntToHexLE / hexLEToBigInt round-trip', () => {
  const n = 0x00000000000000000000000000000000000000000123456789abcdef01234567n;
  assert.strictEqual(hexLEToBigInt(bigIntToHexLE(n)), n);
});

test('compactToTargetLE decodes a compact target to the expected magnitude', () => {
  // compact 0x1e015555 → mantissa 0x015555 << 8*(0x1e-3)
  const c = 0x1e015555;
  const exp = BigInt(c) >> 24n, man = BigInt(c) & 0xffffffn;
  const expected = man << (8n * (exp - 3n));
  assert.strictEqual(hexLEToBigInt(compactToTargetLE(c)), expected);
});

test('meetsTargetLE: all-zero hash meets any target; all-0xff meets only the max', () => {
  const zero = Buffer.alloc(32, 0x00);
  const ffs  = Buffer.alloc(32, 0xff);
  const maxT = 'ff'.repeat(32);
  const midT = bigIntToHexLE(1n << 200n);
  assert.strictEqual(meetsTargetLE(zero, midT), true);
  assert.strictEqual(meetsTargetLE(ffs, maxT), true);
  assert.strictEqual(meetsTargetLE(ffs, midT), false);
});

test('meetsTargetLE treats the Eaglesong hash as big-endian (byte 0 = MSB, per CKB consensus)', () => {
  // hash byte 0 = 0xff, rest 0 → BE value ≈ 2^255 (huge) → must NOT meet a 2^200 target.
  // (A little-endian reading would see 0xff = tiny and wrongly return true.)
  const hiFirst = Buffer.alloc(32, 0x00); hiFirst[0] = 0xff;
  const target  = bigIntToHexLE(1n << 200n);
  assert.strictEqual(meetsTargetLE(hiFirst, target), false);

  // hash byte 31 = 0xff, rest 0 → BE value = 0xff (tiny) → meets a 2^200 target.
  const loLast = Buffer.alloc(32, 0x00); loLast[31] = 0xff;
  assert.strictEqual(meetsTargetLE(loLast, target), true);
});
