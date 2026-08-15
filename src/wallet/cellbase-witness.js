'use strict';
/**
 * cellbase-witness.js — parse the CellbaseWitness molecule.
 *
 *   CellbaseWitness = table { lock: Script, message: Bytes }
 *   Script          = table { code_hash: Byte32, hash_type: byte, args: Bytes }
 *
 * Why this exists: a CKB cellbase in block N pays the miner of block N-11, and
 * the lock to pay is read from block N-11's cellbase witness. So this witness
 * — not our config — is the authoritative record of which wallet earned a
 * block. Reading it here means a later `block_assembler` change (as happened
 * 2026-08-15) cannot misattribute historical income.
 *
 * Molecule table layout: u32 full_size | u32 offset[0..n-1] | fields.
 * Every read is bounds-checked: this parses chain data, and a decoder that
 * trusts its length prefixes is how out-of-bounds reads happen.
 */

const HASH_TYPE = { 0: 'data', 1: 'type', 2: 'data1', 4: 'data2' };

function u32le(buf, off) {
  if (off < 0 || off + 4 > buf.length) {
    throw new Error(`molecule: u32 read at ${off} past end (${buf.length})`);
  }
  return buf.readUInt32LE(off);
}

/** Field boundaries of a molecule table, with the buffer end appended. */
function tableOffsets(buf) {
  if (buf.length < 8) throw new Error(`molecule: table too short (${buf.length})`);
  const full = u32le(buf, 0);
  if (full !== buf.length) {
    throw new Error(`molecule: declared size ${full} != buffer ${buf.length}`);
  }
  const first = u32le(buf, 4);
  if (first < 8 || first > buf.length || first % 4 !== 0) {
    throw new Error(`molecule: bad first offset ${first}`);
  }
  const count = (first - 4) / 4;
  const offs = [];
  for (let i = 0; i < count; i++) {
    const o = u32le(buf, 4 + 4 * i);
    if (o > buf.length) throw new Error(`molecule: offset ${o} past end (${buf.length})`);
    if (i > 0 && o < offs[i - 1]) throw new Error('molecule: offsets not monotonic');
    offs.push(o);
  }
  offs.push(buf.length);
  return offs;
}

/** A molecule Bytes field: u32 length prefix followed by that many bytes. */
function readBytesField(field, what) {
  const len = u32le(field, 0);
  if (4 + len !== field.length) {
    throw new Error(`molecule: ${what} length ${len} != field payload ${field.length - 4}`);
  }
  return field.subarray(4);
}

function parseScript(buf) {
  const o = tableOffsets(buf);
  if (o.length < 4) throw new Error('molecule: Script needs 3 fields');
  const codeHash = buf.subarray(o[0], o[1]);
  if (codeHash.length !== 32) {
    throw new Error(`molecule: Script.code_hash must be 32 bytes, got ${codeHash.length}`);
  }
  const ht = buf.subarray(o[1], o[2]);
  if (ht.length !== 1) {
    throw new Error(`molecule: Script.hash_type must be 1 byte, got ${ht.length}`);
  }
  const hashType = HASH_TYPE[ht[0]];
  if (!hashType) throw new Error(`molecule: unknown hash_type ${ht[0]}`);
  return {
    code_hash: '0x' + codeHash.toString('hex'),
    hash_type: hashType,
    args: '0x' + readBytesField(buf.subarray(o[2], o[3]), 'Script.args').toString('hex'),
  };
}

function parseCellbaseWitness(witnessHex) {
  const hex = String(witnessHex).replace(/^0x/, '');
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('molecule: witness is not valid hex');
  }
  const buf = Buffer.from(hex, 'hex');
  const o = tableOffsets(buf);
  if (o.length < 3) throw new Error('molecule: CellbaseWitness needs 2 fields');
  return {
    lock: parseScript(buf.subarray(o[0], o[1])),
    message: '0x' + readBytesField(buf.subarray(o[1], o[2]), 'message').toString('hex'),
  };
}

module.exports = { parseCellbaseWitness, parseScript };
