'use strict';
/**
 * username.js — miner identity parsing and CKB address validation.
 *
 * Canonical username: <ckb-address>[.<worker-name>]  (decision 12).
 *
 * Address validation follows RFC 0021 (ckb-address-format):
 *   HRP  "ckb" (mainnet) / "ckt" (testnet), separator "1";
 *   payload type 0x00 full  → Bech32m (BIP-350);
 *   payload type 0x01 short → Bech32 (BIP-173);
 *   payload type 0x02/0x04 deprecated full → Bech32.
 * The RFC removes the 90-char bech32 length limit; we still enforce our own
 * bounded cap to protect memory/log (limits.maxUsernameBytes).
 *
 * Rejection (not sanitization) is used for malformed worker names: silently
 * renaming workers would corrupt miner-facing attribution.
 */

// ── bech32 / bech32m (BIP-173, BIP-350) ──────────────────────────────────────
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARSET_REV = (() => {
  const m = new Map();
  for (let i = 0; i < CHARSET.length; i++) m.set(CHARSET[i], i);
  return m;
})();
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  let chk = 1;
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0, ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return ret;
}

/**
 * Encode payload bytes as bech32/bech32m with the given HRP.
 * @param {string} hrp  'ckb' | 'ckt'
 * @param {Buffer|number[]} payloadBytes
 * @param {'bech32'|'bech32m'} variant
 * @returns {string}
 */
function bech32Encode(hrp, payloadBytes, variant) {
  const five = convertBits([...payloadBytes], 8, 5, true);
  const exp = hrpExpand(hrp);
  const constVal = variant === 'bech32m' ? BECH32M_CONST : BECH32_CONST;
  const pm = (polymod([...exp, ...five, 0, 0, 0, 0, 0, 0]) ^ constVal) >>> 0;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...five, ...checksum].map(v => CHARSET[v]).join('');
}

/**
 * Decode a bech32/bech32m string. Tries both constants; returns the payload
 * bytes plus which variant verified.
 * @returns {{hrp:string, data:number[], variant:'bech32'|'bech32m'}|null}
 */
function bech32Decode(str) {
  if (typeof str !== 'string' || str.length < 8) return null;
  const sep = str.lastIndexOf('1');
  if (sep < 1 || sep + 7 > str.length) return null;
  const hrp = str.slice(0, sep);
  const dataPart = str.slice(sep + 1);
  const values = [];
  for (const ch of dataPart) {
    if (ch.toLowerCase() !== ch && ch.toUpperCase() !== ch) return null; // reject mixed case
    const v = CHARSET_REV.get(ch.toLowerCase());
    if (v === undefined) return null;
    values.push(v);
  }
  const exp = hrpExpand(hrp);
  let variant = null;
  if (polymod([...exp, ...values]) === BECH32_CONST) variant = 'bech32';
  else if (polymod([...exp, ...values]) === BECH32M_CONST) variant = 'bech32m';
  if (!variant) return null;
  const payload = convertBits(values.slice(0, -6), 5, 8, false);
  if (!payload) return null;
  return { hrp, data: payload, variant };
}

const HRPS = { ckb: 'mainnet', ckt: 'testnet' };

/**
 * Validate a CKB address string.
 * @param {string} addr
 * @param {string} network  'ckb' | 'ckt'
 * @returns {{ok:boolean, reason?:string, hrp?:string, payloadType?:number, variant?:string}}
 */
function validateCkbAddress(addr, network) {
  if (typeof addr !== 'string' || addr.length === 0) return { ok: false, reason: 'EMPTY_ADDRESS' };
  if (addr.length > 256) return { ok: false, reason: 'ADDRESS_TOO_LONG' };
  if (!(network in HRPS)) return { ok: false, reason: 'UNKNOWN_NETWORK' };

  const dec = bech32Decode(addr);
  if (!dec) return { ok: false, reason: 'BAD_CHECKSUM_OR_FORMAT' };
  if (dec.hrp !== network) {
    return { ok: false, reason: `WRONG_NETWORK`, hrp: dec.hrp };
  }
  if (dec.data.length < 1) return { ok: false, reason: 'EMPTY_PAYLOAD' };

  const type = dec.data[0];
  // RFC 0021: 0x00 full payload uses Bech32m; 0x01/0x02/0x04 use Bech32.
  if (type === 0x00 && dec.variant !== 'bech32m') {
    return { ok: false, reason: 'FULL_PAYLOAD_REQUIRES_BECH32M' };
  }
  if (type !== 0x00 && dec.variant !== 'bech32') {
    return { ok: false, reason: 'NON_FULL_PAYLOAD_REQUIRES_BECH32' };
  }

  if (type === 0x01) {
    // short: 0x01 | code_hash_index | 20-byte args
    if (dec.data.length !== 22) return { ok: false, reason: 'SHORT_PAYLOAD_LENGTH' };
  } else if (type === 0x00) {
    // full: 0x00 | code_hash(32) | hash_type(1) | args
    if (dec.data.length < 34) return { ok: false, reason: 'FULL_PAYLOAD_TOO_SHORT' };
  } else if (type === 0x02 || type === 0x04) {
    // deprecated full: 0x02/0x04 | code_hash(32) | args
    if (dec.data.length < 33) return { ok: false, reason: 'FULL_PAYLOAD_TOO_SHORT' };
  } else {
    return { ok: false, reason: 'UNKNOWN_PAYLOAD_TYPE' };
  }

  return { ok: true, hrp: dec.hrp, payloadType: type, variant: dec.variant };
}

const WORKER_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Parse a stratum username into payout address + worker.
 * @param {string} raw  e.g. "ckb1qy...k7-01"
 * @param {object} limits  { maxUsernameBytes, maxWorkerNameBytes }
 * @returns {{ok:boolean, reason?:string, payoutAddress?:string, worker?:string}}
 */
function parseUsername(raw, network, limits) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'EMPTY_USERNAME' };
  if (raw.length > (limits?.maxUsernameBytes || 200)) return { ok: false, reason: 'USERNAME_TOO_LONG' };

  let address = raw;
  let worker = null;
  const dot = raw.indexOf('.');
  if (dot !== -1) {
    address = raw.slice(0, dot);
    worker = raw.slice(dot + 1);
    if (worker.length === 0) return { ok: false, reason: 'EMPTY_WORKER' };
    if (worker.length > (limits?.maxWorkerNameBytes || 64)) return { ok: false, reason: 'WORKER_TOO_LONG' };
    if (!WORKER_RE.test(worker)) return { ok: false, reason: 'WORKER_INVALID_CHARS' };
  }

  const v = validateCkbAddress(address, network);
  if (!v.ok) return { ok: false, reason: v.reason, detail: v };

  return {
    ok: true,
    payoutAddress: address,
    worker: worker || 'default',   // bare address → generated/default worker name
    detail: v,
  };
}

module.exports = { validateCkbAddress, parseUsername, bech32Decode, bech32Encode };
