'use strict';
/**
 * mine-share.js — find a nonce whose Eaglesong hash meets a target.
 * Test fixture generator: used once to produce deterministic vectors.
 *
 *   node test/tools/mine-share.js <powHashHex64> <targetLEHex64> [maxTries] [seedNonce]
 *   prints: {"nonce":"0x...","hash":"0x..."} on success, exits 1 on failure.
 */

const { eaglesong } = require('../../src/mining/eaglesong.js');

function meetsTargetLE(hashBuf, targetLE) {
  const tLE = Buffer.from(targetLE, 'hex');
  for (let i = 0; i < 32; i++) {
    const tByte = tLE[31 - i];
    if (hashBuf[i] < tByte) return true;
    if (hashBuf[i] > tByte) return false;
  }
  return true;
}

const [,, powHash, targetLE, maxTries = '100000', seed = '0'] = process.argv;
const max = parseInt(maxTries, 10);
const start = parseInt(seed, 10);
const pow = Buffer.from(powHash, 'hex');

for (let i = start; i < start + max; i++) {
  const nonce = i.toString(16).padStart(32, '0');
  const hash = eaglesong(Buffer.concat([pow, Buffer.from(nonce, 'hex')]));
  if (meetsTargetLE(hash, targetLE)) {
    console.log(JSON.stringify({ nonce: '0x' + nonce, hash: '0x' + hash.toString('hex'), tries: i - start + 1 }));
    process.exit(0);
  }
}
console.error(`no nonce found in ${max} tries`);
process.exit(1);
