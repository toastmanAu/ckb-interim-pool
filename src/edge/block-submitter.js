'use strict';
/**
 * block-submitter.js — immediate local-node block submission (critical path).
 *
 * Critical-path rule (decisions 6, spec 02 §2.1): a winning share is
 * validated and submitted to the edge's LOCAL trusted CKB node immediately,
 * synchronously awaited — never waiting for PostgreSQL, NATS or central
 * accounting. Event publication happens after submission.
 *
 * Proven assembly: ckb-merkle.buildBlockForSubmit (real mainnet block
 * reconstruction, byte-for-byte) + upstream submit_block call shape
 * [work_id, block].
 */

const merkle = require('../mining/ckb-merkle.js');

/** Reverse the byte order of a 32-hex-char (16-byte) nonce. */
function reverseNonceHex(nonceHex) {
  const h = nonceHex.replace(/^0x/, '');
  let out = '';
  for (let i = h.length - 2; i >= 0; i -= 2) out += h.slice(i, i + 2);
  return out;
}

/**
 * Minimal hex form required by the node's Uint128 JSON parser
 * (ckb util/jsonrpc-types/src/uints.rs: any leading zero nibble after 0x is
 * rejected as "redundant leading zeros"). Value-preserving: the serialized
 * header bytes (writeU128 LE) are identical.
 *
 * CRITICAL (found live, 2026-08-13): the node serializes the header nonce
 * as a u128 VALUE in little-endian, while miners hash the RAW nonce bytes.
 * The header JSON must therefore carry the byte-REVERSED nonce:
 *   LE(value(hex(reverse(raw)))) == raw  →  the node hashes exactly what
 * the miner hashed. Submitting the raw bytes makes the node hash a
 * different 128-bit value → InvalidNonce even for a genuine block solution.
 */
function minimalNonceHex(noncePadded) {
  const reversed = reverseNonceHex(noncePadded);
  return '0x' + BigInt('0x' + reversed).toString(16);
}

function createBlockSubmitter({ rpcClient, logger = console }) {
  /**
   * @param {string} noncePadded  full 32-hex-char nonce (no 0x), raw bytes
   * @param {object} template     get_block_template result for the solved job
   * @returns {Promise<{ok:boolean, error?:string, latencyMs:number}>}
   */
  async function submitBlock(noncePadded, template) {
    const nonceHex = minimalNonceHex(noncePadded);
    const block = merkle.buildBlockForSubmit(template, nonceHex);
    const t0 = Date.now();
    try {
      const result = await rpcClient.rpc('submit_block', [template.work_id, block]);
      const latencyMs = Date.now() - t0;
      logger.log('BLOCK', `block submitted height=${parseInt(template.number, 16)} nonce=${nonceHex} result=${JSON.stringify(result)} ${latencyMs}ms`);
      return { ok: true, latencyMs, result };
    } catch (e) {
      const latencyMs = Date.now() - t0;
      logger.log('BLOCK', `submit failed: ${e.message}`);
      return { ok: false, error: e.message, latencyMs };
    }
  }

  return { submitBlock };
}

module.exports = { createBlockSubmitter, minimalNonceHex, reverseNonceHex };
