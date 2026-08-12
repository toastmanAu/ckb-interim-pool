'use strict';
/**
 * ckb-merkle.test.js — TDD suite for CKB header-root computation.
 *
 * Every expected value is ground truth pulled from real CKB mainnet blocks
 * (test/fixtures/*.json, fetched via get_block_by_number). If our code
 * reproduces a real block's transactions_root / proposals_hash / extra_hash
 * from its transactions, it is provably correct against the network.
 */

const test = require('node:test');
const assert = require('node:assert');
const { ckbBlake2b } = require('../src/mining/blake2b.js');
const {
  merkleRoot,
  txHash,
  txWitnessHash,
  calcTransactionsRoot,
  calcProposalsHash,
  calcUnclesHash,
  calcExtraHash,
} = require('../src/mining/ckb-merkle.js');

const ZERO32 = '0x' + '00'.repeat(64 / 2);

function load(name) {
  return require(`./fixtures/mainnet-${name}.json`);
}
const cellbaseOnly = load('block-raw');   // #19804160: 1 tx (cellbase), extension present
const multitx      = load('multitx-5');   // #19804274: 4 txs
const proposals    = load('proposals');   // #19804256: 1 tx, 2 proposals
const uncle        = load('uncle');        // #19804362: 1 tx, 1 uncle, extension present

// ── CBMT merkle root ───────────────────────────────────────────────────────
test('merkleRoot of no leaves is the 32-byte zero hash', () => {
  assert.strictEqual(merkleRoot([]).toString('hex'), '00'.repeat(32));
});

test('merkleRoot of a single leaf is that leaf (identity)', () => {
  const leaf = ckbBlake2b(Buffer.from('deadbeef', 'hex'));
  assert.strictEqual(merkleRoot([leaf]).toString('hex'), leaf.toString('hex'));
});

test('merkleRoot of two leaves is blake2b(left || right)', () => {
  const a = ckbBlake2b(Buffer.from('01', 'hex'));
  const b = ckbBlake2b(Buffer.from('02', 'hex'));
  const expected = ckbBlake2b(Buffer.concat([a, b])).toString('hex');
  assert.strictEqual(merkleRoot([a, b]).toString('hex'), expected);
});

// ── Molecule transaction hashing ───────────────────────────────────────────
test('txHash reproduces the cellbase hash from a real block', () => {
  const cb = cellbaseOnly.transactions[0];
  assert.strictEqual(txHash(cb), cb.hash);
});

test('txHash reproduces every tx hash in a multi-tx block', () => {
  for (const tx of multitx.transactions) {
    assert.strictEqual(txHash(tx), tx.hash, `hash mismatch for ${tx.hash}`);
  }
});

test('txWitnessHash differs from txHash (commits to witnesses)', () => {
  const cb = cellbaseOnly.transactions[0];
  assert.notStrictEqual(txWitnessHash(cb), txHash(cb));
});

// ── transactions_root (the bug that was zeroed) ────────────────────────────
test('calcTransactionsRoot matches a real single-tx (cellbase-only) block', () => {
  assert.strictEqual(
    calcTransactionsRoot(cellbaseOnly.transactions),
    cellbaseOnly.header.transactions_root,
  );
});

test('calcTransactionsRoot matches a real multi-tx block (multi-leaf CBMT)', () => {
  assert.strictEqual(
    calcTransactionsRoot(multitx.transactions),
    multitx.header.transactions_root,
  );
});

// ── proposals_hash ─────────────────────────────────────────────────────────
test('calcProposalsHash of empty proposals is the zero hash', () => {
  assert.strictEqual(calcProposalsHash([]), ZERO32);
});

test('calcProposalsHash matches a real block with proposals', () => {
  assert.ok(proposals.proposals.length > 0, 'fixture must have proposals');
  assert.strictEqual(
    calcProposalsHash(proposals.proposals),
    proposals.header.proposals_hash,
  );
});

// ── uncles_hash + extra_hash ───────────────────────────────────────────────
test('calcUnclesHash of empty uncles is the zero hash', () => {
  assert.strictEqual(calcUnclesHash([]), ZERO32);
});

test('extra_hash equals uncles_hash when no extension is present', () => {
  // synthetic: extension undefined → extra_hash == uncles_hash
  assert.strictEqual(calcExtraHash(ZERO32, undefined), ZERO32);
});

test('calcExtraHash matches a real block: empty uncles + extension present', () => {
  const unclesHash = calcUnclesHash(cellbaseOnly.uncles); // empty → zero
  assert.strictEqual(
    calcExtraHash(unclesHash, cellbaseOnly.extension),
    cellbaseOnly.header.extra_hash,
  );
});

test('calcExtraHash matches a real block with a real uncle', () => {
  assert.ok(uncle.uncles.length > 0, 'fixture must have an uncle');
  const unclesHash = calcUnclesHash(uncle.uncles);
  assert.strictEqual(
    calcExtraHash(unclesHash, uncle.extension),
    uncle.header.extra_hash,
  );
});
