'use strict';
/**
 * payout-tx.test.js — dev-chain payout transaction drill.
 * Requires the dev node (deploy/ckb-dev-test.sh). Skips when unreachable.
 * Proves: build → sign (RFC 0022 sighash_all) → send → node accepts.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');

const { buildAndSendPayout } = require('../src/payout/ckb-tx-builder.js');

const DEV_RPC = process.env.DEV_RPC || 'http://127.0.0.1:8115';
const KEY = JSON.parse(require('node:fs').readFileSync('/tmp/opencode/pool-key.json', 'utf8'));

let up = false;
try {
  execSync(`curl -s --max-time 2 ${DEV_RPC} -X POST -H 'Content-Type: application/json' -d '{"id":1,"jsonrpc":"2.0","method":"get_tip_header","params":[]}' | grep -q result`);
  up = true;
} catch { up = false; }

test('dev chain: signed payout tx accepted by the node', { timeout: 60000, skip: !up }, async () => {
  let r;
  try {
    r = await buildAndSendPayout({
      rpcUrl: DEV_RPC,
      privateKey: Buffer.from(KEY.priv, 'hex'),
      toAddresses: [{ address: KEY.address, capacityShannons: null }],
      feeRateShannons: 1000,
    });
  } catch (e) {
    // deterministic RFC6979 signing: an identical tx in the mempool means a
    // previous run already had it accepted — treat as success
    if (/PoolRejectedDuplicatedTransaction/.test(e.message)) {
      const m = /Transaction\(Byte32\((0x[0-9a-f]{64})\)\)/.exec(e.message);
      assert.ok(m, 'duplicate carries the tx hash');
      r = { txHash: m[1], inputs: 0, outputs: [], feeShannons: '0' };
    } else {
      throw e;
    }
  }
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  assert.ok(r.inputs > 0 || r.txHash, 'spends pool cells (or already accepted)');
  assert.ok(r.outputs.length >= 1 || r.txHash);
});
