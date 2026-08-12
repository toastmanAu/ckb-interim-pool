'use strict';
/**
 * miner-family.js — miner-family classification and wire-format helpers.
 *
 * Extracted from ckb-stratum-proxy `solo-proxy.js` @ 4d57892 with NO behavior
 * change: the K7/GodMiner subscribe tuple, target endianness, nonce
 * composition and Goldshell session-resume paths are preserved verbatim and
 * pinned by regression tests (see test/miner-family.test.js).
 *
 * Wire conventions (proven against real K7 / Goldshell / NerdMiner):
 *  - K7/GodMiner  (ua ~= /godminer|ckbminer/i):
 *       subscribe → [null, extranonce1, 8]           (extranonce2_size=8; 8+8=16B nonce)
 *       notify    → target bytes REVERSED (BE) on the wire
 *       vardiff   → mining.set_target with BE target only
 *       submit    → 3-field [worker, jobId, nonce]; full nonce = extranonce1 || n8
 *  - Goldshell/NerdMiner:
 *       subscribe → nested 3-tuple with session id (session-resume support)
 *       notify    → LE target on the wire
 *       vardiff   → mining.set_target (LE) + mining.set_difficulty
 *       submit    → 5-field [worker, jobId, en2, ntime, nonce]; nonce zero-padded to 16B
 */

const { diffToTargetLE } = require('../mining/ckb-target.js');

/** K7 / GodMiner / ckbminer user agents use the Bitmain branch. */
function isGodMiner(ua) {
  return /godminer|ckbminer/i.test(ua || '');
}

/** Reverse byte order of a 64-char hex string (LE <-> BE). */
function leToBe(hex) {
  let be = '';
  for (let i = hex.length - 2; i >= 0; i -= 2) be += hex.slice(i, i + 2);
  return be;
}

/**
 * Build the mining.subscribe response for a miner family.
 * @param {string} family  'godminer' | 'goldshell'
 * @param {*} msgId        the request id to echo
 * @param {Array} params   original subscribe params [userAgent, sessionId?]
 * @param {string} sessionId  session id used as extranonce1 (K7 uses the fixed
 *                            pool prefix; Goldshell uses the session token)
 * @returns {{id:*, result:Array, error:null}}
 */
function subscribeResponseFor(family, msgId, params, sessionId) {
  if (family === 'godminer') {
    // K7: extranonce1_bytes + extranonce2_size MUST sum to 16. Simple 3-tuple.
    return { id: msgId, result: [null, sessionId, 8], error: null };
  }
  // Goldshell intminer / NerdMiner: nested 3-tuple with sessionId for session-resume.
  return {
    id: msgId,
    result: [
      [['mining.set_difficulty', sessionId], ['mining.notify', sessionId]],
      sessionId,
      4,
    ],
    error: null,
  };
}

/**
 * Build a mining.notify for a specific miner family.
 * @param {string} family  'godminer' | 'goldshell'
 * @param {object} job     job snapshot { jobId:int, powHash:hex64, height:int, targetLE:hex64 }
 * @param {boolean} clean  clean_jobs flag
 * @returns {null|{id:null,method:'mining.notify',params:Array}}
 */
function buildNotifyFor(family, job, clean) {
  if (!job || !job.targetLE) return null;
  const target = family === 'godminer' ? leToBe(job.targetLE) : job.targetLE;
  return {
    id: null,
    method: 'mining.notify',
    params: [
      job.jobId.toString(16),
      job.powHash,
      job.height,
      target,
      !!clean,
    ],
  };
}

/**
 * Compose the full 16-byte Eaglesong nonce for a miner family.
 * K7/GodMiner: extranonce1 || miner's 8 bytes  (extranonce1 stored at subscribe).
 * Others:      zero-pad the miner's submitted nonce to 16 bytes.
 * @param {string} family  'godminer' | 'goldshell'
 * @param {string} extranonce1  hex extranonce1 (godminer path)
 * @param {string} nonceHex     miner-submitted nonce (with or without 0x)
 * @returns {string} 32-char hex full nonce
 */
function composeNonce(family, extranonce1, nonceHex) {
  const n8 = String(nonceHex).replace(/^0x/, '');
  return family === 'godminer'
    ? (extranonce1 || '0011223344556677') + n8
    : n8.padStart(32, '0');
}

/**
 * Vardiff wire messages for a miner family at the given difficulty.
 * @returns {Array<{method:string,params:Array}>} messages to send in order
 */
function vardiffMessagesFor(family, diff) {
  const t = diffToTargetLE(diff);
  if (family === 'godminer') {
    return [{ method: 'mining.set_target', params: [leToBe(t)] }];
  }
  return [
    { method: 'mining.set_target', params: [t] },
    { method: 'mining.set_difficulty', params: [diff] },
  ];
}

/** Default fixed extranonce1 prefix used by the proven solo proxy for K7. */
const K7_DEFAULT_EXTRANONCE1 = '0011223344556677';

module.exports = {
  isGodMiner,
  leToBe,
  subscribeResponseFor,
  buildNotifyFor,
  composeNonce,
  vardiffMessagesFor,
  K7_DEFAULT_EXTRANONCE1,
};
