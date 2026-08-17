'use strict';
/** The signing builder must never feed an immature cellbase into a tx. */
const test = require('node:test');
const assert = require('node:assert');
const { collectPoolCells, selectMaturePoolCells } = require('../src/wallet/tx-builder.js');

const packedEpoch = (number, index = 0, length = 100) =>
  '0x' + (BigInt(number) | (BigInt(index) << 24n) | (BigInt(length) << 40n)).toString(16);

function rawCell({ capacity, height, epoch, cellbase, suffix }) {
  return {
    output: { capacity: '0x' + BigInt(capacity).toString(16) },
    block_number: '0x' + height.toString(16),
    block_epoch: epoch,
    tx_index: cellbase ? '0x0' : '0x1',
    out_point: { tx_hash: '0x' + suffix.repeat(32), index: '0x0' },
  };
}

test('filters immature cellbase cells and selects mature inputs oldest-first', () => {
  const rawCells = [
    rawCell({ capacity: 500, height: 50, epoch: packedEpoch(17), cellbase: true, suffix: '50' }),
    rawCell({ capacity: 100, height: 100, epoch: packedEpoch(10), cellbase: true, suffix: '10' }),
    rawCell({ capacity: 75, height: 200, epoch: packedEpoch(17), cellbase: false, suffix: '20' }),
    rawCell({ capacity: 200, height: 300, epoch: packedEpoch(11), cellbase: true, suffix: '30' }),
  ];

  const result = selectMaturePoolCells({
    rawCells,
    tipEpochHex: packedEpoch(18),
    targetShannons: '150',
  });

  assert.strictEqual(result.total, '175');
  assert.deepStrictEqual(result.selected.map(cell => cell.outPoint.tx_hash), [
    '0x' + '10'.repeat(32),
    '0x' + '20'.repeat(32),
  ]);
  assert.ok(!result.selected.some(cell => cell.outPoint.tx_hash === '0x' + '50'.repeat(32)),
    'the oldest cell is immature and must not enter selection');
});

test('fails closed when mature cells cannot cover the requested value', () => {
  const rawCells = [
    rawCell({ capacity: 500, height: 50, epoch: packedEpoch(17), cellbase: true, suffix: '50' }),
    rawCell({ capacity: 100, height: 100, epoch: packedEpoch(10), cellbase: true, suffix: '10' }),
  ];

  assert.throws(() => selectMaturePoolCells({
    rawCells,
    tipEpochHex: packedEpoch(18),
    targetShannons: '150',
  }), /mature.*cover|insufficient/i);
});

test('the indexer collection path applies maturity and oldest-first selection', async () => {
  const calls = [];
  const rawCells = [
    rawCell({ capacity: 500, height: 50, epoch: packedEpoch(17), cellbase: true, suffix: '50' }),
    rawCell({ capacity: 100, height: 100, epoch: packedEpoch(10), cellbase: true, suffix: '10' }),
    rawCell({ capacity: 75, height: 200, epoch: packedEpoch(17), cellbase: false, suffix: '20' }),
  ];
  const rpcClient = async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === 'get_tip_header') return { number: '0x12c', epoch: packedEpoch(18) };
    if (method === 'get_cells') return { objects: rawCells, last_cursor: '0x' };
    throw new Error(`unexpected ${method}`);
  };

  const cells = await collectPoolCells({
    nodeUrl: 'http://node',
    indexerUrl: 'http://indexer',
    lock: { code_hash: '0x' + '11'.repeat(32), hash_type: 'type', args: '0x' + '22'.repeat(20) },
    minCapacity: 150n,
    rpcClient,
  });

  assert.deepStrictEqual(cells.map(cell => cell.tx_hash), [
    '0x' + '10'.repeat(32),
    '0x' + '20'.repeat(32),
  ]);
  const indexCall = calls.find(call => call.method === 'get_cells');
  assert.strictEqual(indexCall.params[0].order, 'asc');
});
