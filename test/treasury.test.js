'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spendableSplit } = require('../src/wallet/treasury.js');

const cell = (capacity, epochNumber, isCellbase = true) =>
  ({ capacity, blockEpochNumber: epochNumber, isCellbase });

test('cellbase cells are unspendable until 4 epochs after their block', () => {
  const r = spendableSplit({
    cells: [cell('100', 10), cell('200', 14), cell('400', 15)],
    tipEpochNumber: 18,
  });
  // matures at 14 and 18 -> spendable; matures at 19 -> not
  assert.strictEqual(r.total, '700');
  assert.strictEqual(r.spendable, '300');
  assert.strictEqual(r.cellCount, 3);
});

test('non-cellbase cells are spendable immediately', () => {
  const r = spendableSplit({ cells: [cell('500', 18, false)], tipEpochNumber: 18 });
  assert.strictEqual(r.spendable, '500');
});

test('an empty cell set reports zero without pretending it is authoritative', () => {
  const r = spendableSplit({ cells: [], tipEpochNumber: 18 });
  assert.strictEqual(r.total, '0');
  assert.strictEqual(r.spendable, '0');
  assert.strictEqual(r.cellCount, 0);
});
