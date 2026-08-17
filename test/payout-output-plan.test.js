'use strict';
/** Fixed payouts must return excess input capacity to the treasury lock. */
const test = require('node:test');
const assert = require('node:assert');
const { planPayoutAmounts, decodeRecipientAddress } = require('../src/wallet/tx-builder.js');

const SHORT = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const FULL = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4';
const LOCK = {
  code_hash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
  hash_type: 'type',
  args: '0xb39bbc0b3673c7d36450bc14cfcdad2d559c6c64',
};

test('short and full recipients resolve to the same output lock', () => {
  assert.deepStrictEqual(decodeRecipientAddress(SHORT), LOCK);
  assert.deepStrictEqual(decodeRecipientAddress(FULL), LOCK);
});

test('fixed payouts preserve input excess as change', () => {
  assert.deepStrictEqual(planPayoutAmounts({
    totalIn: 500n,
    fixedAmounts: [100n, 150n],
    estimatedFee: 10n,
    sweep: false,
    minChangeShannons: 50n,
  }), { fixedSum: 250n, sweepAmount: null, changeAmount: 240n, actualFee: 10n });
});

test('a sweep sends the remainder to the sweep target and creates no change', () => {
  assert.deepStrictEqual(planPayoutAmounts({
    totalIn: 500n,
    fixedAmounts: [100n],
    estimatedFee: 10n,
    sweep: true,
    minChangeShannons: 50n,
  }), { fixedSum: 100n, sweepAmount: 390n, changeAmount: 0n, actualFee: 10n });
});

test('sub-minimum change is deliberately absorbed into the fee', () => {
  assert.deepStrictEqual(planPayoutAmounts({
    totalIn: 155n,
    fixedAmounts: [100n],
    estimatedFee: 10n,
    sweep: false,
    minChangeShannons: 50n,
  }), { fixedSum: 100n, sweepAmount: null, changeAmount: 0n, actualFee: 55n });
});

test('output planning refuses insufficient input capacity', () => {
  assert.throws(() => planPayoutAmounts({
    totalIn: 100n,
    fixedAmounts: [95n],
    estimatedFee: 10n,
    sweep: false,
  }), /insufficient/i);
});
