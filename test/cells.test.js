'use strict';
/**
 * Treasury cell collection and selection. Pool income is cellbase output, so
 * selecting newest cells or omitting epoch metadata creates transactions the
 * node will reject as immature.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  parseEpochFields,
  classifyCells,
  selectOldestFirst,
  collectLiveCells,
  treasuryView,
} = require('../src/wallet/cells.js');

const LOCK = {
  code_hash: '0x' + '11'.repeat(32),
  hash_type: 'type',
  args: '0x' + '22'.repeat(20),
};

const packedEpoch = (number, index = 0, length = 1800) =>
  '0x' + (BigInt(number) | (BigInt(index) << 24n) | (BigInt(length) << 40n)).toString(16);

const raw = (capacity, blockNumber, epochHex, isCellbase, suffix = '00') => ({
  output: { capacity },
  block_number: '0x' + blockNumber.toString(16),
  tx_index: isCellbase ? '0x0' : '0x1',
  out_point: { tx_hash: '0x' + suffix.repeat(32), index: '0x0' },
  block_epoch: epochHex,
});

test('parses packed EpochNumberWithFraction fields', () => {
  assert.deepStrictEqual(parseEpochFields('0x4e8024c003994'),
    { number: 14740, index: 588, length: 1256 });
  assert.deepStrictEqual(parseEpochFields('0x5d5000f00399a'),
    { number: 14746, index: 15, length: 1493 });
});

test('refuses malformed or impossible epoch fractions', () => {
  assert.throws(() => parseEpochFields('not-hex'), /epoch/i);
  assert.throws(() => parseEpochFields(packedEpoch(10, 0, 0)), /length/i);
  assert.throws(() => parseEpochFields(packedEpoch(10, 100, 100)), /index/i);
});

test('classifies a cellbase by transaction position and preserves its epoch', () => {
  const [cellbase, ordinary] = classifyCells([
    raw('0x1', 100, '0x4e8024c003994', true),
    raw('0x2', 100, '0x4e8024c003994', false),
  ]);
  assert.strictEqual(cellbase.isCellbase, true);
  assert.strictEqual(ordinary.isCellbase, false);
  assert.deepStrictEqual(cellbase.blockEpoch, { number: 14740, index: 588, length: 1256 });
  assert.strictEqual(cellbase.capacity, '1');
});

test('selects oldest-first without mutating the caller array', () => {
  const cells = classifyCells([
    raw('0x64', 300, packedEpoch(10), true, '03'),
    raw('0x64', 100, packedEpoch(10), true, '01'),
    raw('0x64', 200, packedEpoch(10), true, '02'),
  ]);
  const originalOrder = cells.map(cell => cell.blockNumber);
  const { selected, total } = selectOldestFirst(cells, 150n);

  assert.strictEqual(total, '200');
  assert.deepStrictEqual(selected.map(cell => cell.blockNumber), [100, 200]);
  assert.deepStrictEqual(cells.map(cell => cell.blockNumber), originalOrder);
});

test('selection returns all available cells when the target cannot be covered', () => {
  const cells = classifyCells([raw('0x64', 100, packedEpoch(10), true)]);
  const { selected, total } = selectOldestFirst(cells, 10_000n);
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(total, '100');
});

test('zero target and an empty cell set select nothing', () => {
  const one = classifyCells([raw('0x64', 100, packedEpoch(10), true)]);
  assert.deepStrictEqual(selectOldestFirst(one, 0n), { selected: [], total: '0' });
  assert.deepStrictEqual(selectOldestFirst([], 100n), { selected: [], total: '0' });
});

test('collects ascending indexer pages and hydrates each unique block epoch', async () => {
  const calls = [];
  const pages = [
    {
      objects: [
        raw('0x64', 100, undefined, true, '01'),
        raw('0xc8', 100, undefined, false, '02'),
      ],
      last_cursor: '0xnext',
    },
    {
      objects: [raw('0x12c', 200, undefined, true, '03')],
      last_cursor: '0x',
    },
  ];
  let page = 0;
  const rpc = async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === 'get_cells') return pages[page++];
    if (method === 'get_header_by_number') {
      return { epoch: params[0] === '0x64' ? packedEpoch(10) : packedEpoch(11, 1) };
    }
    throw new Error(`unexpected RPC ${method}`);
  };

  const cells = await collectLiveCells({ indexerUrl: 'http://indexer', nodeUrl: 'http://node', lock: LOCK, rpc });

  assert.strictEqual(cells.length, 3);
  assert.deepStrictEqual(cells.map(cell => cell.block_epoch),
    [packedEpoch(10), packedEpoch(10), packedEpoch(11, 1)]);
  const pageCalls = calls.filter(call => call.method === 'get_cells');
  assert.strictEqual(pageCalls.length, 2);
  assert.strictEqual(pageCalls[0].params[0].order, 'asc');
  assert.ok(!Object.hasOwn(pageCalls[0].params[0], 'after'));
  assert.strictEqual(pageCalls[1].params[0].after, '0xnext');
  assert.strictEqual(calls.filter(call => call.method === 'get_header_by_number').length, 2,
    'cells in the same block share one header lookup');
});

test('an empty authoritative indexer result remains empty', async () => {
  const calls = [];
  const cells = await collectLiveCells({
    indexerUrl: 'http://indexer', nodeUrl: 'http://node', lock: LOCK,
    rpc: async (url, method) => {
      calls.push({ url, method });
      return { objects: [], last_cursor: '0xstale-cursor' };
    },
  });
  assert.deepStrictEqual(cells, []);
  assert.deepStrictEqual(calls.map(call => call.method), ['get_cells']);
});

test('treasury view separates mature cellbase value from total value', () => {
  const view = treasuryView({
    rawCells: [
      raw('0x64', 100, packedEpoch(10), true),
      raw('0xc8', 200, packedEpoch(15), true),
      raw('0x32', 300, packedEpoch(18), false),
    ],
    tipEpochHex: packedEpoch(18),
  });
  assert.strictEqual(view.total, '350');
  assert.strictEqual(view.spendable, '150');
  assert.strictEqual(view.cellCount, 3);
});
