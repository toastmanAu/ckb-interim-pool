'use strict';
/**
 * keystore.test.js — fail-to-start checks around the wallet signing key.
 *
 * A wrong key is otherwise a silent failure: it derives another wallet,
 * reports no cells and pays nobody while appearing healthy. The key must
 * also never escape through operational errors.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { bech32Decode, validateCkbAddress } = require('../src/stratum/username.js');
const { loadKeystore, deriveLock, lockToAddress } = require('../src/wallet/keystore.js');

// Throwaway fixture used nowhere outside this test.
const KEY = '0101010101010101010101010101010101010101010101010101010101010101';
const dirs = [];

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function keyFile(contents = KEY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-'));
  dirs.push(dir);
  const file = path.join(dir, 'payout.privkey');
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

test('derives a stable secp256k1_blake160 lock from a key', () => {
  const lock = deriveLock(Buffer.from(KEY, 'hex'));
  assert.strictEqual(lock.code_hash,
    '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8');
  assert.strictEqual(lock.hash_type, 'type');
  assert.match(lock.args, /^0x[0-9a-f]{40}$/);
  assert.strictEqual(deriveLock(Buffer.from(KEY, 'hex')).args, lock.args);
});

test('loads a key file and reports its derived mainnet address', () => {
  const ks = loadKeystore({ keyPath: keyFile() });
  assert.strictEqual(validateCkbAddress(ks.address, 'ckb').ok, true);
  assert.strictEqual(ks.lock.args, deriveLock(Buffer.from(KEY, 'hex')).args);
  assert.ok(Buffer.isBuffer(ks.privateKey));
  assert.strictEqual(ks.privateKey.toString('hex'), KEY);
});

test('encodes a full bech32m address containing the exact derived lock', () => {
  const lock = deriveLock(Buffer.from(KEY, 'hex'));
  const address = lockToAddress(lock, 'ckt');
  const decoded = bech32Decode(address);

  assert.strictEqual(validateCkbAddress(address, 'ckt').ok, true);
  assert.strictEqual(decoded.variant, 'bech32m');
  assert.strictEqual(decoded.hrp, 'ckt');
  assert.strictEqual(decoded.data[0], 0x00);
  assert.strictEqual(Buffer.from(decoded.data.slice(1, 33)).toString('hex'), lock.code_hash.slice(2));
  assert.strictEqual(decoded.data[33], 0x01);
  assert.strictEqual(Buffer.from(decoded.data.slice(34)).toString('hex'), lock.args.slice(2));
});

test('refuses to start when the key file is missing', () => {
  assert.throws(() => loadKeystore({ keyPath: '/nonexistent/payout.privkey' }), /key file/i);
});

test('refuses a key file that is not exactly 32 bytes of hex', () => {
  assert.throws(() => loadKeystore({ keyPath: keyFile('nothex') }), /32 bytes|hex/i);
  assert.throws(() => loadKeystore({ keyPath: keyFile('aabb') }), /32 bytes/i);
});

test('refuses invalid secp256k1 scalars without echoing them', () => {
  const zero = '00'.repeat(32);
  const file = keyFile(zero);
  assert.throws(() => loadKeystore({ keyPath: file }), error => {
    assert.match(error.message, /invalid private key/i);
    assert.ok(!error.message.includes(zero));
    assert.ok(!error.stack.includes(zero));
    return true;
  });
});

test('refuses to start when the derived address is not the expected one', () => {
  assert.throws(
    () => loadKeystore({ keyPath: keyFile(), expectedAddress: 'ckb1qsomethingelse' }),
    /expected address/i);
});

test('accepts a matching expected address', () => {
  const ks = loadKeystore({ keyPath: keyFile() });
  const again = loadKeystore({ keyPath: keyFile(), expectedAddress: ks.address });
  assert.strictEqual(again.address, ks.address);
});

test('rejects an unsupported network before reading the key', () => {
  const missing = '/nonexistent/should-not-be-read.privkey';
  assert.throws(() => loadKeystore({ keyPath: missing, network: 'foo' }), /network/i);
});

test('no mismatch error contains the key', () => {
  const file = keyFile();
  assert.throws(() => loadKeystore({ keyPath: file, expectedAddress: 'ckb1qwrong' }), error => {
    assert.ok(!error.message.includes(KEY), 'key leaked into an error message');
    assert.ok(!error.stack.includes(KEY), 'key leaked into a stack trace');
    return true;
  });
});
