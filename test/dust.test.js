'use strict';
/**
 * Dust classification. A CKB output cell must carry capacity for its own
 * serialized bytes, so "too small to pay" is a protocol floor derived from the
 * recipient's own lock — not a fee-economics preference and not a constant.
 */
const test = require('node:test');
const assert = require('node:assert');
const { cellFloorShannons, payableFloorForAddress, classifyBalance } = require('../src/wallet/dust.js');

// Both live pool miners are plain secp256k1_blake160_sighash_all (20-byte args).
const SECP_ADDRESS = 'ckb1qyq9qjett7ngswt065q5t5ypk0p6c9sgqdlq8gfx5c';
const SECP_LOCK = {
  code_hash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
  hash_type: 'type',
  args: '0x' + '11'.repeat(20),
};
const MINIMUM = 100_000_000_000n;   // POOL_MIN_PAYOUT_SHANNONS, 1000 CKB

test('a 20-byte-args lock floors at 61 CKB', () => {
  // 8 capacity + 32 code_hash + 1 hash_type + 20 args = 61 bytes
  assert.strictEqual(cellFloorShannons(SECP_LOCK), 6_100_000_000n);
});

test('the floor grows with the recipient lock args, it is not a constant', () => {
  const omnilock = { ...SECP_LOCK, args: '0x' + '11'.repeat(21) };
  assert.strictEqual(cellFloorShannons(omnilock), 6_200_000_000n);
});

test('an empty-args lock still pays for its fixed 41 bytes', () => {
  assert.strictEqual(cellFloorShannons({ ...SECP_LOCK, args: '0x' }), 4_100_000_000n);
});

test('a malformed args field is refused rather than under-costed', () => {
  assert.throws(() => cellFloorShannons({ ...SECP_LOCK, args: 'deadbeef' }), /args/);
  assert.throws(() => cellFloorShannons({ ...SECP_LOCK, args: '0xabc' }), /args/);
  assert.throws(() => cellFloorShannons(null), /lock/);
});

test('the floor for a real payout address is derived by decoding it', () => {
  assert.strictEqual(payableFloorForAddress(SECP_ADDRESS), 6_100_000_000n);
});

test('a balance at or above the payout minimum is a normal payable', () => {
  assert.strictEqual(
    classifyBalance({ balance: MINIMUM, floor: 6_100_000_000n, minimumPayout: MINIMUM }),
    'payable');
});

test('a balance below the minimum but above the cell floor is dust', () => {
  assert.strictEqual(
    classifyBalance({ balance: 30_412_301_268n, floor: 6_100_000_000n, minimumPayout: MINIMUM }),
    'dust');
});

test('a balance exactly at the cell floor is dust, not unpayable', () => {
  assert.strictEqual(
    classifyBalance({ balance: 6_100_000_000n, floor: 6_100_000_000n, minimumPayout: MINIMUM }),
    'dust');
});

test('a balance one shannon below the cell floor cannot be paid at all', () => {
  assert.strictEqual(
    classifyBalance({ balance: 6_099_999_999n, floor: 6_100_000_000n, minimumPayout: MINIMUM }),
    'unpayable');
});

test('a zero or negative balance is unpayable, never swept', () => {
  assert.strictEqual(
    classifyBalance({ balance: 0n, floor: 6_100_000_000n, minimumPayout: MINIMUM }), 'unpayable');
  assert.strictEqual(
    classifyBalance({ balance: -1n, floor: 6_100_000_000n, minimumPayout: MINIMUM }), 'unpayable');
});

/**
 * Recipient floor enforcement. tx-builder sizes CHANGE and SWEEP outputs
 * against MIN_SIGHASH_CELL_SHANNONS but emitted recipient amounts verbatim, so
 * a sub-floor payout signed cleanly and died on broadcast with
 * -302 InsufficientCellCapacity. Fail before the network, not after.
 */
const { assertRecipientsPayable } = require('../src/wallet/dust.js');
const { buildPayoutTransaction } = require('../src/wallet/tx-builder.js');

test('recipients at or above their own floor are accepted', () => {
  assert.doesNotThrow(() => assertRecipientsPayable([
    { address: SECP_ADDRESS, capacityShannons: '6100000000' },
    { address: SECP_ADDRESS, capacityShannons: '100000000000' },
  ]));
});

test('a sub-floor recipient is refused with its address and both amounts', () => {
  assert.throws(
    () => assertRecipientsPayable([{ address: SECP_ADDRESS, capacityShannons: '6099999999' }]),
    (e) => e.message.includes(SECP_ADDRESS) &&
           e.message.includes('6099999999') &&
           e.message.includes('6100000000'),
  );
});

test('a sweep recipient is exempt because its amount is computed later', () => {
  assert.doesNotThrow(() => assertRecipientsPayable([
    { address: SECP_ADDRESS, capacityShannons: null },
  ]));
});

test('the offending recipient is named even when it is not the first', () => {
  assert.throws(() => assertRecipientsPayable([
    { address: SECP_ADDRESS, capacityShannons: '100000000000' },
    { address: SECP_ADDRESS, capacityShannons: '1' },
  ]), /index 1/);
});

test('buildPayoutTransaction rejects a sub-floor recipient before touching the node', async () => {
  // An unroutable rpcUrl: if the guard did not run first this would fail with
  // a connection error instead, which is exactly the pre-fix behaviour.
  await assert.rejects(
    () => buildPayoutTransaction({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: Buffer.alloc(32, 7),
      toAddresses: [{ address: SECP_ADDRESS, capacityShannons: '5000000000' }],
    }),
    /below the minimum cell capacity/,
  );
});

/**
 * The guard must sit on the path the WALLET actually calls. The in-process
 * builder's buildBatchTransfer delegates to buildBatchPayout, not to
 * buildPayoutTransaction directly — a check verified only against the latter
 * would be a check at a layer the service never reaches.
 */
const { buildBatchPayout } = require('../src/wallet/tx-builder.js');

test('the batch path the payout worker uses enforces the floor too', async () => {
  await assert.rejects(
    () => buildBatchPayout({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: Buffer.alloc(32, 7),
      items: [
        { address: SECP_ADDRESS, capacityShannons: '100000000000' },
        { address: SECP_ADDRESS, capacityShannons: '5000000000' },
      ],
    }),
    /index 1 .* below the minimum cell capacity 6100000000/s,
  );
});
