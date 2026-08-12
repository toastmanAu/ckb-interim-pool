'use strict';
/**
 * gen-pplns-vectors.js — generate + freeze the PPLNS golden vectors.
 *
 *   node test/tools/gen-pplns-vectors.js  → writes test/vectors/pplns-golden.json
 *
 * The JSON is the canonical conformance contract for the interim pool and the
 * future Community Pool signer (spec 08 §7). Regenerating must produce an
 * identical file (determinism check in the test suite).
 */

const fs = require('node:fs');
const path = require('node:path');
const { allocateBlock } = require('../../src/pplns/pplns.js');

const W = { num: 2, den: 1 };
const NET_WORK = '1000000000000000000000';          // 1e21
const REWARD = '110000000000';                        // 1100 CKB in shannons
const FEE_BPS = 100;

const share = (i, miner, work) => ({ shareId: `s-${String(i).padStart(3, '0')}`, miner, workUnits: work });

function vector(name, input) {
  const out = allocateBlock(input);
  return { name, input: { ...input, orderedShares: input.orderedShares }, expected: out };
}

// work values in "work units" (≈ hashes); a K7 share at diff 470k ≈ 2e15
const D1 = '4294967296';                                   // diff 1
const D470K = '2018634629120000000';                      // ~470k diff share
const D1M = '4294967296000000';                           // 1M diff share
const BIG = '90071992547409930000000000000000000000';     // > 2^53 × 2^32 (float-unsafe)

const vectors = [];

// 1. one miner, everything
vectors.push(vector('one-miner', {
  rewardShannons: REWARD, feeBps: FEE_BPS, windowNum: W.num, windowDen: W.den,
  networkWork: NET_WORK,
  orderedShares: [share(1, 'A', D1), share(2, 'A', D1), share(3, 'A', D1)],
}));

// 2. two equal miners
vectors.push(vector('two-equal-miners', {
  rewardShannons: REWARD, feeBps: FEE_BPS, windowNum: W.num, windowDen: W.den,
  networkWork: NET_WORK,
  orderedShares: [share(1, 'A', D470K), share(2, 'B', D470K), share(3, 'A', D470K), share(4, 'B', D470K)],
}));

// 3. unequal work
vectors.push(vector('unequal-work', {
  rewardShannons: REWARD, feeBps: FEE_BPS, windowNum: W.num, windowDen: W.den,
  networkWork: NET_WORK,
  orderedShares: [share(1, 'A', D470K), share(2, 'A', D470K), share(3, 'B', D1)],
}));

// 4. vardiff shares (mixed small/large work, same miner)
vectors.push(vector('vardiff-mixed', {
  rewardShannons: REWARD, feeBps: FEE_BPS, windowNum: W.num, windowDen: W.den,
  networkWork: NET_WORK,
  orderedShares: [
    share(1, 'A', D1), share(2, 'A', D1), share(3, 'B', D470K),
    share(4, 'A', D1M), share(5, 'A', D1), share(6, 'B', D470K), share(7, 'A', D1),
  ],
}));

// 5. exact window boundary (cumulative == window target exactly)
const EXACT_NET = '4000000000000000000000';
vectors.push(vector('exact-window-boundary', {
  rewardShannons: REWARD, feeBps: FEE_BPS, windowNum: W.num, windowDen: W.den,
  networkWork: EXACT_NET,
  // window target = 2 × 4e21 = 8e21; four 2e21 shares sum exactly to it
  orderedShares: [
    share(1, 'A', '2000000000000000000000'), share(2, 'B', '2000000000000000000000'),
    share(3, 'A', '2000000000000000000000'), share(4, 'B', '2000000000000000000000'),
  ],
}));

// 6. crossing share included (window target lands mid-share)
vectors.push(vector('boundary-crossing-share-included', {
  rewardShannons: REWARD, feeBps: FEE_BPS, windowNum: W.num, windowDen: W.den,
  networkWork: '3000000000000000000000',   // target = 6e21
  orderedShares: [
    share(1, 'A', '1000000000000000000000'),
    share(2, 'B', '4000000000000000000000'),   // crosses the target
    share(3, 'C', '1000000000000000000000'),   // beyond — excluded
  ],
}));

// 7. very large work values (float-unsafe)
vectors.push(vector('very-large-work', {
  rewardShannons: REWARD, feeBps: FEE_BPS, windowNum: W.num, windowDen: W.den,
  networkWork: BIG,
  orderedShares: [share(1, 'A', BIG), share(2, 'B', BIG), share(3, 'A', BIG)],
}));

// 8. fee calculation with odd reward (floor fee)
vectors.push(vector('fee-floor-odd-reward', {
  rewardShannons: '100000000001', feeBps: 100, windowNum: W.num, windowDen: W.den,
  networkWork: NET_WORK,
  orderedShares: [share(1, 'A', D470K), share(2, 'A', D470K)],
}));

// 9. largest-remainder tie rule (equal work, odd distributable → +1 to key-asc)
vectors.push(vector('largest-remainder-tie', {
  rewardShannons: '100000000003', feeBps: 0, windowNum: W.num, windowDen: W.den,
  networkWork: NET_WORK,
  orderedShares: [
    share(1, 'bbb', D470K), share(2, 'aaa', D470K),
    share(3, 'bbb', D470K), share(4, 'aaa', D470K),
  ],
}));

// 10. config snapshot change: W=3 widens the window → different allocation
vectors.push(vector('window-multiplier-change-w3', {
  rewardShannons: REWARD, feeBps: FEE_BPS, windowNum: 3, windowDen: 1,
  networkWork: NET_WORK,
  orderedShares: [
    share(1, 'A', D470K), share(2, 'B', D470K), share(3, 'C', D470K),
    share(4, 'A', D470K), share(5, 'B', D470K), share(6, 'C', D470K),
  ],
}));

const out = { generated_by: 'test/tools/gen-pplns-vectors.js', vectors };
fs.writeFileSync(path.join(__dirname, '..', 'vectors', 'pplns-golden.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors`);
