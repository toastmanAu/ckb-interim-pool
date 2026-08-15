'use strict';
/**
 * block-hash-regression.test.js — pins candidate-block-hash recomputation
 * against REAL blocks this pool won on CKB mainnet.
 *
 * Why this file exists (incident 2026-08-14): the accounting service marked
 * both blocks ORPHANED while they were, and still are, canonical. The header
 * nonce is serialized by the node as a u128 VALUE in little-endian, while
 * miners hash the RAW nonce bytes — so the recomputed header must carry the
 * byte-REVERSED nonce. A build without that reversal recomputes a hash that
 * can never match the chain, which the tracker read as "we lost the race".
 *
 * These are pure functions over recorded chain data (no DB, no node), so they
 * belong in the always-run suite: a regression here means every future block
 * the pool wins is silently discarded.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { candidateBlockHash } = require('../src/accounting/block-tracker.js');
const { minimalNonceHex, reverseNonceHex } = require('../src/edge/block-submitter.js');
const { ckbBlake2b } = require('../src/mining/blake2b.js');
const { serializeFullHeader } = require('../src/mining/ckb-header.js');

const WON = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'won-blocks-mainnet.json'), 'utf8'),
);

test('fixture integrity: each won block is canonical (its child builds on it)', () => {
  assert.ok(WON.blocks.length >= 2, 'need the two 2026-08-14 blocks');
  for (const b of WON.blocks) {
    assert.strictEqual(
      b.child_parent_hash, b.canonical_hash,
      `block ${b.height} must be canonical — child's parent_hash proves it`,
    );
  }
});

for (const b of WON.blocks) {
  test(`won block ${b.height}: candidateBlockHash reproduces the canonical hash`, () => {
    const got = candidateBlockHash(b.template, b.raw_nonce);
    assert.strictEqual(
      '0x' + got, b.canonical_hash,
      `recomputed hash must equal the chain's — a mismatch makes the tracker ` +
      `declare this won block ORPHANED and drop its ${Number(b.reward_shannons) / 1e8} CKB`,
    );
  });

  test(`won block ${b.height}: submitted nonce is the byte-reversed raw nonce`, () => {
    assert.strictEqual(minimalNonceHex(b.raw_nonce), b.canonical_nonce);
  });

  test(`won block ${b.height}: the UN-reversed nonce must NOT match (pins the reversal)`, () => {
    // this is exactly what the stale 2026-08-14 build computed
    const unreversed = ckbBlake2b(serializeFullHeader({
      version: b.template.version,
      compact_target: b.template.compact_target,
      timestamp: b.template.current_time,
      number: b.template.number,
      epoch: b.template.epoch,
      parent_hash: b.template.parent_hash,
      transactions_root: b.template.transactions_root,
      proposals_hash: b.template.proposals_hash,
      extra_hash: b.template.extra_hash,
      dao: b.template.dao,
    }, '0x' + BigInt(b.raw_nonce).toString(16))).toString('hex');

    assert.notStrictEqual(
      '0x' + unreversed, b.canonical_hash,
      'if this ever matches, the reversal is no longer load-bearing and the ' +
      'test above has stopped proving anything',
    );
  });
}

test('reverseNonceHex pads short minimal-form nonces before reversing', () => {
  // the node returns nonces in minimal form (leading zeros stripped); reversing
  // without padding back to 16 bytes yields a different value entirely
  const padded = 'ab'.repeat(16);
  assert.strictEqual(reverseNonceHex('0x' + padded).length, 32);
  assert.strictEqual(reverseNonceHex('0x1'), '01' + '00'.repeat(15));
  assert.strictEqual(reverseNonceHex(reverseNonceHex('0x' + padded)), padded);
});
