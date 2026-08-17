'use strict';
/**
 * keystore.js — the only wallet module that reads signing-key bytes.
 *
 * The treasury lock is derived from the key rather than configured. A caller
 * may additionally assert the expected address so accidentally provisioning a
 * different valid key is a fail-to-start error instead of a silent empty
 * wallet.
 */

const fs = require('node:fs');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { lockOf } = require('../payout/ckb-tx-builder.js');
const { bech32Encode } = require('../stratum/username.js');

const HASH_TYPE_BYTE = Object.freeze({ data: 0, type: 1, data1: 2, data2: 4 });
const NETWORKS = new Set(['ckb', 'ckt']);

function scriptBytes(value, bytes, field) {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${field} must be a 0x-prefixed ${bytes}-byte hex string`);
  }
  return Buffer.from(value.slice(2), 'hex');
}

/**
 * Encode a CKB full address: 0x00 | code_hash | hash_type | args, bech32m.
 *
 * @param {{code_hash:string, hash_type:string, args:string}} lock
 * @param {'ckb'|'ckt'} [hrp]
 * @returns {string}
 */
function lockToAddress(lock, hrp = 'ckb') {
  if (!NETWORKS.has(hrp)) throw new Error(`unsupported CKB network ${hrp}`);
  if (!lock || typeof lock !== 'object') throw new Error('lock script is required');

  const hashType = HASH_TYPE_BYTE[lock.hash_type];
  if (hashType === undefined) throw new Error(`unknown hash_type ${lock.hash_type}`);
  const payload = Buffer.concat([
    Buffer.from([0x00]),
    scriptBytes(lock.code_hash, 32, 'code_hash'),
    Buffer.from([hashType]),
    scriptBytes(lock.args, 20, 'args'),
  ]);
  return bech32Encode(hrp, payload, 'bech32m');
}

/**
 * @param {Buffer|Uint8Array} privateKey
 * @returns {{code_hash:string, hash_type:'type', args:string}}
 */
function deriveLock(privateKey) {
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return lockOf(Buffer.from(publicKey).toString('hex'));
}

/**
 * Read and validate a wallet key exactly once during process startup.
 *
 * @param {object} options
 * @param {string} options.keyPath
 * @param {string|null} [options.expectedAddress]
 * @param {'ckb'|'ckt'} [options.network]
 * @returns {{privateKey:Buffer, lock:object, address:string}}
 */
function loadKeystore({ keyPath, expectedAddress = null, network = 'ckb' }) {
  if (!NETWORKS.has(network)) throw new Error(`unsupported CKB network ${network}`);

  let raw;
  try {
    raw = fs.readFileSync(keyPath, 'utf8').trim();
  } catch (error) {
    throw new Error(`key file unreadable at ${keyPath}: ${error.code || 'read failed'}`);
  }

  const hex = raw.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`key file at ${keyPath} must contain exactly 32 bytes of hex`);
  }

  const privateKey = Buffer.from(hex, 'hex');
  let lock;
  try {
    lock = deriveLock(privateKey);
  } catch {
    // Do not forward library errors: they must never include key material.
    throw new Error(`invalid private key in key file at ${keyPath}`);
  }
  const address = lockToAddress(lock, network);

  if (expectedAddress && address !== expectedAddress) {
    throw new Error(
      `key at ${keyPath} derives ${address} but expected address is ${expectedAddress}; ` +
      'refusing to operate a different wallet');
  }

  return { privateKey, lock, address };
}

module.exports = { loadKeystore, deriveLock, lockToAddress };
