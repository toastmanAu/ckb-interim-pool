'use strict';
/**
 * cellbase-witness.test.js — the CellbaseWitness molecule records which lock
 * mined a block. Block N+11 pays that lock, so this parse is what attributes
 * income to the right wallet. Pinned against a real mainnet block the pool won.
 */
const test = require('node:test');
const assert = require('node:assert');
const { parseCellbaseWitness } = require('../src/wallet/cellbase-witness.js');

// block 20152836, won by this pool 2026-08-14 (149 bytes / 298 hex chars)
const REAL = '0x' +
  '950000000c00000055000000490000001000000030000000310000009bd7e06f' +
  '3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce801140000' +
  '005ea0977c3cab6898817c9860fe70d26acf559f763c0000000000000020302e' +
  '3230392e3020286431363665323820323032362d30372d323929206d696e6564' +
  '2062792077796c74656b20696e6475737472696573';

test('parses the lock from a real mainnet cellbase witness', () => {
  const { lock } = parseCellbaseWitness(REAL);
  assert.strictEqual(lock.code_hash,
    '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8');
  assert.strictEqual(lock.hash_type, 'type');
  assert.strictEqual(lock.args, '0x5ea0977c3cab6898817c9860fe70d26acf559f76');
});

test('rejects a truncated witness rather than returning a partial lock', () => {
  assert.throws(() => parseCellbaseWitness(REAL.slice(0, 40)), /molecule/i);
});

test('rejects a table whose declared size disagrees with the buffer', () => {
  // full_size says 0xff bytes, buffer is far shorter
  assert.throws(() => parseCellbaseWitness('0xff0000000c00000010000000'), /molecule/i);
});

test('rejects an offset pointing past the end', () => {
  // full_size 12, first offset 0xffff
  assert.throws(() => parseCellbaseWitness('0x0c000000ffff0000'), /molecule/i);
});
