'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spendableSplit } = require('../src/wallet/treasury.js');

const epoch = (number, index = 0, length = 1800) => ({ number, index, length });
const cell = (capacity, blockEpoch, isCellbase = true) =>
  ({ capacity, blockEpoch, isCellbase });

test('cellbase cells are unspendable until 4 epochs after their block', () => {
  const r = spendableSplit({
    cells: [cell('100', epoch(10)), cell('200', epoch(14)), cell('400', epoch(15))],
    tipEpoch: epoch(18),
  });
  // matures at 14 and 18 -> spendable; matures at 19 -> not
  assert.strictEqual(r.total, '700');
  assert.strictEqual(r.spendable, '300');
  assert.strictEqual(r.cellCount, 3);
});

test('maturity carries the block epoch fraction — not the truncated number', () => {
  // A cell created halfway through epoch 14 matures halfway through epoch 18.
  // Comparing integer epoch numbers alone calls it spendable the moment the
  // tip enters epoch 18, which is up to a whole epoch EARLY; the node rejects
  // a spend of it as immature. reconciler.js rounds its recorded
  // `mature_at_epoch` up for the same reason — the two must not disagree.
  const halfway = cell('500', epoch(14, 900, 1800));

  const justBefore = spendableSplit({ cells: [halfway], tipEpoch: epoch(18, 899, 1800) });
  assert.strictEqual(justBefore.spendable, '0',
    'one block short of the maturing point is not spendable');

  const exactly = spendableSplit({ cells: [halfway], tipEpoch: epoch(18, 900, 1800) });
  assert.strictEqual(exactly.spendable, '500', 'spendable exactly at the maturing point');
});

test('the fraction compares across differing epoch lengths', () => {
  // epochs vary in length; 450/900 and 900/1800 are the same instant
  const halfway = cell('500', epoch(14, 900, 1800));
  assert.strictEqual(
    spendableSplit({ cells: [halfway], tipEpoch: epoch(18, 450, 900) }).spendable, '500');
  assert.strictEqual(
    spendableSplit({ cells: [halfway], tipEpoch: epoch(18, 449, 900) }).spendable, '0');
});

test('a later epoch number is mature regardless of fraction', () => {
  const late = cell('500', epoch(14, 1799, 1800));
  assert.strictEqual(
    spendableSplit({ cells: [late], tipEpoch: epoch(19, 0, 1800) }).spendable, '500');
});

test('non-cellbase cells are spendable immediately', () => {
  const r = spendableSplit({ cells: [cell('500', epoch(18), false)], tipEpoch: epoch(18) });
  assert.strictEqual(r.spendable, '500');
});

test('an empty cell set reports zero without pretending it is authoritative', () => {
  const r = spendableSplit({ cells: [], tipEpoch: epoch(18) });
  assert.strictEqual(r.total, '0');
  assert.strictEqual(r.spendable, '0');
  assert.strictEqual(r.cellCount, 0);
});

test('a malformed epoch is refused, never guessed', () => {
  assert.throws(() => spendableSplit({ cells: [], tipEpoch: { number: 18, index: 0, length: 0 } }),
    /length must be positive/);
  assert.throws(() => spendableSplit({ cells: [cell('1', undefined)], tipEpoch: epoch(18) }),
    /blockEpoch must be/);
});
