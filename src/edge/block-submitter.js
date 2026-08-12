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

function createBlockSubmitter({ rpcClient, logger = console }) {
  /**
   * @param {string} noncePadded  full 32-hex-char nonce (no 0x)
   * @param {object} template     get_block_template result for the solved job
   * @returns {Promise<{ok:boolean, error?:string, latencyMs:number}>}
   */
  async function submitBlock(noncePadded, template) {
    const nonceHex = '0x' + noncePadded.padStart(32, '0');
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

module.exports = { createBlockSubmitter };
