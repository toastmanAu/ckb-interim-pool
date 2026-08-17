'use strict';
/** Fixed payouts must return excess input capacity to the treasury lock. */
const test = require('node:test');
const assert = require('node:assert');
const { planPayoutAmounts } = require('../src/wallet/tx-builder.js');

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
