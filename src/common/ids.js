'use strict';
/**
 * ids.js — globally unique identifiers for the pool.
 *
 *  - UUIDv7 (RFC 9562): time-ordered, unique across processes/restarts.
 *  - edge_boot_id: UUIDv7 generated once per edge process start.
 *  - edge_seq: per-boot monotonic sequence (1-based). Uniqueness is guaranteed
 *    by the composite (edge_id, boot_id, edge_seq); the DB enforces it.
 *  - job id: `${bootId8hex}${seqHex}` — globally distinguishable across
 *    restarts (spec 03 §4), still an opaque hex string to miners.
 */

const crypto = require('node:crypto');

/** RFC 9562 UUIDv7 — 48-bit ms timestamp, 74 random bits. */
function uuidv7() {
  const buf = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  buf.writeUInt32BE(Number((ms >> 16n) & 0xffffffffn), 0);
  buf.writeUInt16BE(Number(ms & 0xffffn), 4);
  buf[6] = 0x70 | (buf[6] & 0x0f);       // version 7
  buf[8] = 0x80 | (buf[8] & 0x3f);       // variant RFC 9562
  return buf.toString('hex');
}

/** Monotonic per-boot sequence counter (1-based). */
function createEdgeSeq() {
  let n = 0;
  return {
    next() { n += 1; return n; },
    get value() { return n; },
    reset() { n = 0; },
  };
}

/** Compose a wire job id from a boot id and a job sequence number. */
function jobIdFor(bootId, seq) {
  return bootId.slice(0, 8) + seq.toString(16).padStart(8, '0');
}

/** 8-byte hex extranonce1 prefix derived from a UUIDv7 (unique per session). */
function extranonce1For(bootId, sessionSeq) {
  return (bootId.slice(0, 8) + sessionSeq.toString(16).padStart(8, '0')).slice(0, 16);
}

module.exports = { uuidv7, createEdgeSeq, jobIdFor, extranonce1For };
