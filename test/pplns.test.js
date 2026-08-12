'use strict';
/**
 * pplns.test.js — deterministic PPLNS engine tests.
 *
 *  - golden vectors: test/vectors/pplns-golden.json (checked in, frozen;
 *    regeneration must reproduce the identical file);
 *  - conservation + property tests (spec 07 §4);
 *  - order determinism / tie rules.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { allocateBlock } = require('../src/pplns/pplns.js');

const GOLDEN_PATH = path.join(__dirname, 'vectors', 'pplns-golden.json');
const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

const share = (i, miner, work) => ({ shareId: `s-${String(i).padStart(3, '0')}`, miner, workUnits: work });

// ── golden vectors ───────────────────────────────────────────────────────────
for (const v of golden.vectors) {
  test(`golden: ${v.name}`, () => {
    const out = allocateBlock(v.input);
    assert.deepStrictEqual(out, v.expected);
  });
}

test('golden file is regenerable (frozen determinism)', () => {
  execSync('node test/tools/gen-pplns-vectors.js');
  const after = fs.readFileSync(GOLDEN_PATH, 'utf8');
  const before = JSON.stringify(golden, null, 2) + '\n';
  assert.strictEqual(after, before, 'regeneration must not change the golden file');
});

// ── conservation / properties ────────────────────────────────────────────────
test('conservation: credits + fee + rounding == reward for many random cases', () => {
  const miners = ['a', 'b', 'c', 'd'];
  for (let trial = 0; trial < 300; trial++) {
    const reward = BigInt(1_000_000 + ((trial * 7919) % 90_000_000));
    const feeBps = [0, 100, 100, 250, 500, 1000, 2500][trial % 7];
    const shares = [];
    const n = 1 + (trial % 12);
    for (let i = 0; i < n; i++) {
      const work = BigInt(2 ** (1 + (trial * 13 + i * 7) % 60)) * BigInt(1 + ((trial + i) % 5));
      shares.push(share(i, miners[(trial + i) % miners.length], work.toString()));
    }
    const out = allocateBlock({
      rewardShannons: reward.toString(),
      feeBps,
      windowNum: 2, windowDen: 1,
      networkWork: shares.reduce((a, s) => a + BigInt(s.workUnits), 0n).toString(),
      orderedShares: shares,
    });
    const sum = out.allocation.reduce((a, x) => a + BigInt(x.creditShannons), 0n)
      + BigInt(out.feeShannons) + BigInt(out.roundingShannons);
    assert.strictEqual(sum, reward, `trial ${trial}: conservation`);
    assert.ok(BigInt(out.feeShannons) === (reward * BigInt(feeBps)) / 10000n, `trial ${trial}: fee floor`);
  }
});

test('allocation never exceeds distributable reward', () => {
  const out = allocateBlock({
    rewardShannons: '1000000', feeBps: 100,
    windowNum: 2, windowDen: 1, networkWork: '1000000000',
    orderedShares: [share(1, 'a', '100'), share(2, 'b', '1'), share(3, 'a', '100')],
  });
  const total = out.allocation.reduce((a, x) => a + BigInt(x.creditShannons), 0n);
  assert.ok(total <= 1_000_000n - 10_000n, 'credits ≤ distributable');
});

test('deterministic: same input → identical output (incl. hash)', () => {
  const input = {
    rewardShannons: '123456789012345', feeBps: 150,
    windowNum: 2, windowDen: 1, networkWork: '99999999999999999999999',
    orderedShares: [
      share(1, 'x', '4294967296'), share(2, 'y', '2018634629120000000'),
      share(3, 'x', '4294967296'), share(4, 'z', '4294967296000000'),
    ],
  };
  assert.deepStrictEqual(allocateBlock(input), allocateBlock(input));
});

test('window: only shares back to the window target are included', () => {
  // window target = 2 × 1e12 = 2e12; 20 shares of 2e11 → only last 10 count
  const shares = [];
  for (let i = 0; i < 20; i++) shares.push(share(i, 'a', '200000000000'));
  const out = allocateBlock({
    rewardShannons: '1000000', feeBps: 0, windowNum: 2, windowDen: 1,
    networkWork: '1000000000000', orderedShares: shares,
  });
  assert.strictEqual(out.totalWork, '2000000000000', 'exactly 10 shares × 2e11');
  assert.strictEqual(out.windowStartShareId, 's-010');
  assert.strictEqual(out.windowEndShareId, 's-019');
});

test('no float arithmetic: 2^53-scale work sums exactly', () => {
  const big = '90071992547409930000000000000000000000';   // > 2^53 × 2^32
  const out = allocateBlock({
    rewardShannons: '5000000', feeBps: 0, windowNum: 2, windowDen: 1,
    networkWork: (BigInt(big) * 2n).toString(),   // window target = 4×big ≥ 3×big
    orderedShares: [share(1, 'a', big), share(2, 'b', big), share(3, 'a', big)],
  });
  assert.strictEqual(out.totalWork, (BigInt(big) * 3n).toString());
});

test('largest remainder: leftover shannons go to largest fractional remainder', () => {
  // distributable = 100000000003, two miners equal work → floor 50000000001 each,
  // leftover 1 → tie broken by miner key ascending ('aaa')
  const out = allocateBlock({
    rewardShannons: '100000000003', feeBps: 0, windowNum: 2, windowDen: 1,
    networkWork: '1000000000000000000000',
    orderedShares: [
      share(1, 'bbb', '4294967296'), share(2, 'aaa', '4294967296'),
      share(3, 'bbb', '4294967296'), share(4, 'aaa', '4294967296'),
    ],
  });
  const credits = new Map(out.allocation.map(a => [a.miner, a.creditShannons]));
  assert.strictEqual(credits.get('aaa'), '50000000002');
  assert.strictEqual(credits.get('bbb'), '50000000001');
});

test('empty share list rejected', () => {
  assert.throws(() => allocateBlock({
    rewardShannons: '1', feeBps: 0, windowNum: 2, windowDen: 1,
    networkWork: '1', orderedShares: [],
  }), /no shares/);
});

test('window multiplier is configurable (num/den)', () => {
  const shares = [];
  for (let i = 0; i < 30; i++) shares.push(share(i, 'a', '200000000000'));
  const base = allocateBlock({
    rewardShannons: '1000000', feeBps: 0, windowNum: 1, windowDen: 1,
    networkWork: '1000000000000', orderedShares: shares,
  });
  const doubled = allocateBlock({
    rewardShannons: '1000000', feeBps: 0, windowNum: 2, windowDen: 1,
    networkWork: '1000000000000', orderedShares: shares,
  });
  assert.strictEqual(base.totalWork, '1000000000000', 'W=1 → 5 shares');
  assert.strictEqual(doubled.totalWork, '2000000000000', 'W=2 → 10 shares');
});
