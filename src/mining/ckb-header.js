/**
 * ckb-header.js — CKB block header serialization + pow_hash computation
 *
 * CKB uses Molecule (a packed binary codec) for all serialization.
 * The RawHeader struct fields (in order) are:
 *   version         u32  LE
 *   compact_target  u32  LE
 *   timestamp       u64  LE
 *   number          u64  LE
 *   epoch           u64  LE
 *   parent_hash     Byte32
 *   transactions_root Byte32
 *   proposals_hash  Byte32
 *   extra_hash      Byte32
 *   dao             Byte32
 *
 * pow_hash = ckbBlake2b(molecule_encode(RawHeader with nonce=0))
 *
 * The full Header also includes:
 *   nonce           u128 LE  (bytes 192-207 of the serialized header)
 *
 * References:
 *   https://github.com/nervosnetwork/ckb/blob/develop/util/types/schemas/blockchain.mol
 *   https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0027-block-structure/0027-block-structure.md
 */

'use strict';

const { ckbBlake2b } = require('./blake2b.js');

/** Write u32 LE into buf at offset */
function writeU32(buf, offset, val) {
  const n = BigInt(val);
  buf[offset]   = Number(n & 0xffn);
  buf[offset+1] = Number((n >> 8n) & 0xffn);
  buf[offset+2] = Number((n >> 16n) & 0xffn);
  buf[offset+3] = Number((n >> 24n) & 0xffn);
}

/** Write u64 LE into buf at offset from hex string "0x..." or number */
function writeU64(buf, offset, val) {
  let n = typeof val === 'bigint' ? val : BigInt(val);
  for (let i = 0; i < 8; i++) { buf[offset+i] = Number(n & 0xffn); n >>= 8n; }
}

/** Write u128 LE into buf at offset from hex string "0x..." */
function writeU128(buf, offset, hexVal) {
  let n = BigInt(hexVal);
  for (let i = 0; i < 16; i++) { buf[offset+i] = Number(n & 0xffn); n >>= 8n; }
}

/** Copy 32-byte hex string into buf at offset */
function writeBytes32(buf, offset, hex) {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  b.copy(buf, offset);
}

/**
 * serializeRawHeader(fields) → Buffer(192)
 *
 * fields from get_block_template result:
 *   version, compact_target, current_time (timestamp), number, epoch,
 *   parent_hash, transactions_root (from template), proposals_hash,
 *   extra_hash (from template.uncles_hash or computed), dao
 *
 * Molecule RawHeader = 4+4+8+8+8+32+32+32+32+32 = 192 bytes (no length prefix — fixed size)
 */
function serializeRawHeader(f) {
  const buf = Buffer.alloc(192, 0);
  let o = 0;
  writeU32  (buf, o, BigInt(f.version));        o += 4;
  writeU32  (buf, o, BigInt(f.compact_target));  o += 4;
  writeU64  (buf, o, BigInt(f.timestamp));       o += 8;
  writeU64  (buf, o, BigInt(f.number));          o += 8;
  writeU64  (buf, o, BigInt(f.epoch));           o += 8;
  writeBytes32(buf, o, f.parent_hash);           o += 32;
  writeBytes32(buf, o, f.transactions_root);     o += 32;
  writeBytes32(buf, o, f.proposals_hash);        o += 32;
  writeBytes32(buf, o, f.extra_hash);            o += 32;
  writeBytes32(buf, o, f.dao);                   o += 32;
  // o == 192
  return buf;
}

/**
 * computePowHash(rawHeaderFields) → hex string (64 chars, no 0x prefix)
 *
 * pow_hash = ckbBlake2b(raw_header_bytes)  (nonce field is NOT included)
 */
function computePowHash(f) {
  const raw = serializeRawHeader(f);
  return ckbBlake2b(raw).toString('hex');
}

/**
 * serializeFullHeader(rawHeaderFields, nonce) → Buffer(208)
 * For submitting a solved block back to the node.
 * nonce: hex string "0x..." (128-bit / 32 hex chars)
 */
function serializeFullHeader(f, nonce) {
  const buf = Buffer.alloc(208, 0);
  serializeRawHeader(f).copy(buf, 0);
  writeU128(buf, 192, nonce.startsWith('0x') ? nonce : '0x' + nonce);
  return buf;
}

/**
 * parseEpoch(epochHex) → { length, index, number }
 * CKB epoch encoding: 0x{length[16]}{index[16]}{number[24]}
 */
function parseEpoch(epochHex) {
  const n = BigInt(epochHex);
  return {
    number: Number(n & 0xffffffn),
    index:  Number((n >> 24n) & 0xffffn),
    length: Number((n >> 40n) & 0xffffn),
  };
}

module.exports = { serializeRawHeader, computePowHash, serializeFullHeader, parseEpoch };
