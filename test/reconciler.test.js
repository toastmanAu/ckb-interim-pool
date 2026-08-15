'use strict';
/**
 * reconciler.test.js — income attribution against recorded mainnet blocks.
 *
 * The bug this pins: accounting read reward_shannons from the pool's OWN
 * cellbase, which in CKB pays the miner of N-11. For block 20160918 that read
 * 829.54 CKB against an actual 675.06 — a 154.48 CKB over-record that would
 * have become a real overpayment once a payout worker existed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { matchReceipt, REWARD_DELAY_BLOCKS, CELLBASE_MATURITY_EPOCHS } =
  require('../src/wallet/reconciler.js');

const FX = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'treasury-receipts-mainnet.json'), 'utf8'));

test('constants match CKB consensus', () => {
  assert.strictEqual(REWARD_DELAY_BLOCKS, 11);
  assert.strictEqual(CELLBASE_MATURITY_EPOCHS, 4);
});

for (const c of FX.cases) {
  test(`block ${c.blockHeight}: attributes the H+11 payment correctly`, () => {
    const r = matchReceipt({
      blockHeight: c.blockHeight,
      cellbaseWitness: c.cellbaseWitness,
      payoutBlock: c.payoutBlock,
    });
    assert.ok(r, 'must find a receipt');
    assert.strictEqual(r.lockArgs, c.expectedLockArgs);
    assert.strictEqual(r.payoutBlockHeight, c.payoutBlockHeight);
    assert.strictEqual(r.payoutTxHash, c.payoutTxHash);
    assert.strictEqual(r.outputIndex, c.outputIndex);
    assert.strictEqual(r.amountShannons, c.amountShannons);
    assert.strictEqual(r.matureAtEpoch, c.matureAtEpoch);
  });
}

test('the recorded reward differs from the block\'s own cellbase — that was the bug', () => {
  const bad = FX.cases.find(c => c.blockHeight === 20160918);
  assert.notStrictEqual(bad.amountShannons, bad.accountingRecordedShannons);
  const delta = BigInt(bad.accountingRecordedShannons) - BigInt(bad.amountShannons);
  assert.ok(delta > 15000000000n, `over-record should exceed 150 CKB, got ${delta}`);
});

test('refuses a payout block at the wrong height rather than guessing', () => {
  const c = FX.cases[0];
  const wrong = JSON.parse(JSON.stringify(c.payoutBlock));
  wrong.header.number = '0x' + (c.payoutBlockHeight + 1).toString(16);
  assert.throws(() => matchReceipt({
    blockHeight: c.blockHeight, cellbaseWitness: c.cellbaseWitness, payoutBlock: wrong,
  }), /height/i);
});

test('returns null when no output pays our lock', () => {
  const c = FX.cases[0];
  const other = JSON.parse(JSON.stringify(c.payoutBlock));
  for (const o of other.transactions[0].outputs) o.lock.args = '0x' + 'ee'.repeat(20);
  assert.strictEqual(matchReceipt({
    blockHeight: c.blockHeight, cellbaseWitness: c.cellbaseWitness, payoutBlock: other,
  }), null);
});
