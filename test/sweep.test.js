'use strict';
/** Cold sweeps may move only genuine surplus to a verified CKB lock. */
const test = require('node:test');
const assert = require('node:assert');

const { sweepAmount, validateColdAddress } = require('../src/wallet/sweep.js');

const SHORT_MAINNET = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const FULL_MAINNET = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4';
const SHORT_TESTNET = 'ckt1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jq5t63cs';
const SIGHASH_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
const LOCK_ARGS = '0xb39bbc0b3673c7d36450bc14cfcdad2d559c6c64';

test('sweeps only spendable value above both the float and unpaid debt', () => {
  assert.strictEqual(sweepAmount({
    spendable: '900000000000', floatShannons: '500000000000', owedUnpaid: '0',
  }), '400000000000');
  assert.strictEqual(sweepAmount({
    spendable: '900000000000', floatShannons: '500000000000', owedUnpaid: '300000000000',
  }), '100000000000');
});

test('returns zero when spendable value cannot cover the protected amount', () => {
  assert.strictEqual(sweepAmount({
    spendable: '100000000000', floatShannons: '500000000000', owedUnpaid: '0',
  }), '0');
  assert.strictEqual(sweepAmount({
    spendable: '900000000000', floatShannons: '500000000000', owedUnpaid: '900000000000',
  }), '0');
});

test('rejects malformed or negative monetary inputs rather than guessing', () => {
  for (const [field, value] of [
    ['spendable', '-1'],
    ['floatShannons', '1.5'],
    ['owedUnpaid', '0x10'],
  ]) {
    const input = { spendable: '10', floatShannons: '2', owedUnpaid: '1', [field]: value };
    assert.throws(() => sweepAmount(input), new RegExp(field, 'i'));
  }
});

test('rejects bad checksums and a valid address for the wrong network', () => {
  assert.throws(() => validateColdAddress('ckb1qnonsense', 'ckb'), /checksum|decode|format/i);
  assert.throws(() => validateColdAddress(SHORT_TESTNET, 'ckb'), /network|mainnet/i);
});

test('short and full mainnet addresses decode to the same exact lock', () => {
  for (const address of [SHORT_MAINNET, FULL_MAINNET]) {
    assert.deepStrictEqual(validateColdAddress(address, 'ckb'), {
      code_hash: SIGHASH_CODE_HASH,
      hash_type: 'type',
      args: LOCK_ARGS,
    });
  }
});

