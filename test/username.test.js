'use strict';
/**
 * username.test.js — CKB address/worker parsing per RFC 0021.
 *
 * Golden vectors: the RFC 0021 examples (full bech32m + deprecated short
 * bech32) plus structural checks.
 */
const test = require('node:test');
const assert = require('node:assert');
const { validateCkbAddress, parseUsername } = require('../src/stratum/username.js');

const LIMITS = { maxUsernameBytes: 200, maxWorkerNameBytes: 64 };

// RFC 0021 golden vectors
const FULL_ADDR   = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4';
const SHORT_ADDR  = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';

test('RFC 0021 full address (bech32m, type 0x00) validates', () => {
  const v = validateCkbAddress(FULL_ADDR, 'ckb');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.variant, 'bech32m');
  assert.strictEqual(v.payloadType, 0x00);
});

test('RFC 0021 short address (bech32, type 0x01) validates', () => {
  const v = validateCkbAddress(SHORT_ADDR, 'ckb');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.variant, 'bech32');
  assert.strictEqual(v.payloadType, 0x01);
});

test('wrong network HRP rejected', () => {
  assert.strictEqual(validateCkbAddress(SHORT_ADDR, 'ckt').ok, false);
  const t = validateCkbAddress('ckt1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v', 'ckt');
  // not a valid checksum (HRP participates in checksum) → must fail as format
  assert.strictEqual(t.ok, false);
});

test('testnet short address of same payload checksum validates as ckt', () => {
  const { bech32Decode, bech32Encode } = require('../src/stratum/username.js');
  const dec = bech32Decode(SHORT_ADDR);
  const tAddr = bech32Encode('ckt', Buffer.from(dec.data), 'bech32');
  const v = validateCkbAddress(tAddr, 'ckt');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.hrp, 'ckt');
  assert.strictEqual(v.payloadType, 0x01);
});

test('corrupted checksum rejected', () => {
  assert.strictEqual(validateCkbAddress(SHORT_ADDR.slice(0, -1) + 'q', 'ckb').ok, false);
  assert.strictEqual(validateCkbAddress('ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5x', 'ckb').ok, false);
});

test('invalid characters rejected', () => {
  assert.strictEqual(validateCkbAddress('ckb1qyq0i', 'ckb').ok, false);        // '0' not in charset
  assert.strictEqual(validateCkbAddress('ckb1qyq!i', 'ckb').ok, false);
  assert.strictEqual(validateCkbAddress('', 'ckb').ok, false);
  assert.strictEqual(validateCkbAddress('ckb1qyq', 'ckb').ok, false);
});

test('unknown payload type rejected', () => {
  // type byte 0x03 is not defined by RFC 0021
  const { bech32Encode } = require('../src/stratum/username.js');
  const bad = bech32Encode('ckb', Buffer.concat([Buffer.from([0x03]), Buffer.alloc(21)]), 'bech32');
  const v = validateCkbAddress(bad, 'ckb');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'UNKNOWN_PAYLOAD_TYPE');
});

// ── username parsing ─────────────────────────────────────────────────────────
test('parseUsername: address with worker', () => {
  const r = parseUsername(`${SHORT_ADDR}.k7-01`, 'ckb', LIMITS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.payoutAddress, SHORT_ADDR);
  assert.strictEqual(r.worker, 'k7-01');
});

test('parseUsername: bare address gets default worker', () => {
  const r = parseUsername(SHORT_ADDR, 'ckb', LIMITS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.worker, 'default');
});

test('parseUsername: worker name charset enforced', () => {
  assert.strictEqual(parseUsername(`${SHORT_ADDR}.a_b-2`, 'ckb', LIMITS).ok, true);
  assert.strictEqual(parseUsername(`${SHORT_ADDR}.bad worker!`, 'ckb', LIMITS).ok, false);
  assert.strictEqual(parseUsername(`${SHORT_ADDR}.`, 'ckb', LIMITS).ok, false);
  assert.strictEqual(parseUsername(`${SHORT_ADDR}.${'x'.repeat(65)}`, 'ckb', LIMITS).ok, false);
});

test('parseUsername: wrong network address rejected', () => {
  const r = parseUsername(`${SHORT_ADDR}.k7`, 'ckt', LIMITS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'WRONG_NETWORK');
});

test('parseUsername: oversized username rejected', () => {
  const r = parseUsername('ckb1' + 'q'.repeat(500), 'ckb', LIMITS);
  assert.strictEqual(r.ok, false);
});

test('parseUsername: only first dot separates worker (address may not contain dots)', () => {
  const r = parseUsername(`${SHORT_ADDR}.w1.w2`, 'ckb', LIMITS);
  assert.strictEqual(r.ok, false, 'address part with extra dot is invalid');
});

test('parseUsername: empty username rejected', () => {
  assert.strictEqual(parseUsername('', 'ckb', LIMITS).ok, false);
  assert.strictEqual(parseUsername(undefined, 'ckb', LIMITS).ok, false);
  assert.strictEqual(parseUsername(null, 'ckb', LIMITS).ok, false);
});
