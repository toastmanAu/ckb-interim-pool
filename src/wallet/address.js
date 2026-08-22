'use strict';
/**
 * address.js — CKB payout address → lock script.
 *
 * Extracted from tx-builder.js so that modules which only need to reason
 * about a recipient's lock (dust.js sizing a cell floor) do not have to pull
 * in the signer, the RPC client, or a require cycle.
 */

const { bech32Decode } = require('../stratum/username.js');

const SIGHASH_ALL_TYPE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';

function decodeRecipientAddress(address) {
  const decoded = bech32Decode(address);
  if (!decoded) throw new Error(`unsupported address payload: ${address}`);
  const payload = decoded.data;
  if (payload[0] === 0x01) {
    const codeHashes = { 0x00: SIGHASH_ALL_TYPE_HASH };
    const codeHash = codeHashes[payload[1]];
    if (!codeHash) throw new Error(`unsupported code_hash_index ${payload[1]}`);
    return {
      code_hash: codeHash,
      hash_type: 'type',
      args: '0x' + Buffer.from(payload.slice(2)).toString('hex'),
    };
  }
  if (payload[0] === 0x00 && payload.length >= 34) {
    const hashTypes = { 0: 'data', 1: 'type', 2: 'data1', 4: 'data2' };
    const hashType = hashTypes[payload[33]];
    if (!hashType) throw new Error(`unsupported hash_type ${payload[33]}`);
    return {
      code_hash: '0x' + Buffer.from(payload.slice(1, 33)).toString('hex'),
      hash_type: hashType,
      args: '0x' + Buffer.from(payload.slice(34)).toString('hex'),
    };
  }
  throw new Error(`unsupported address payload: ${address}`);
}

module.exports = { decodeRecipientAddress, SIGHASH_ALL_TYPE_HASH };
