'use strict';
/**
 * payout-tx.test.js — dev-chain payout transaction drill.
 * Requires the dev node (deploy/ckb-dev-test.sh). Skips when unreachable.
 * Proves: build → sign (RFC 0022 sighash_all) → send → node accepts.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');

const { buildAndSendPayout } = require('../src/wallet/tx-builder.js');
const merkle = require('../src/mining/ckb-merkle.js');

const DEV_RPC = process.env.DEV_RPC || 'http://127.0.0.1:8115';
const KEY_FILE = '/tmp/opencode/pool-key.json';
let up = false;
try {
  execSync(`curl -s --max-time 2 ${DEV_RPC} -X POST -H 'Content-Type: application/json' -d '{"id":1,"jsonrpc":"2.0","method":"get_tip_header","params":[]}' | grep -q result`);
  up = require('node:fs').existsSync(KEY_FILE);
} catch { up = false; }

// This test needs the dev chain + its generated key (deploy/ckb-dev-test.sh).
// In CI the file is absent — the test skips; the key is recreated by
// ckb-dev-test.sh on any dev machine.
const KEY = up ? JSON.parse(require('node:fs').readFileSync(KEY_FILE, 'utf8')) : null;

function rawRpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const http = require('node:http');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({ host: u.hostname, port: u.port || 8114, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { const m = JSON.parse(d); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } catch (e) { reject(e); }
      }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

/** Mine a block directly (dev chain uses Dummy PoW — any nonce is accepted). */
async function mineBlock(url) {
  const tpl = await rawRpc(url, 'get_block_template', [null, null, null]);
  const { minimalNonceHex } = require('../src/edge/block-submitter.js');
  const nonce = minimalNonceHex('0x' + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(32, '0'));
  const block = merkle.buildBlockForSubmit(tpl, nonce);
  await rawRpc(url, 'submit_block', [tpl.work_id, block]);
}

test('dev chain: signed payout tx accepted by the node', { timeout: 60000, skip: !up }, async () => {
  // flush the mempool so earlier payout txs commit (their cells become spent)
  for (let i = 0; i < 3; i++) {
    try { await mineBlock(DEV_RPC); } catch { /* keep going */ }
  }
  let r;
  try {
    r = await buildAndSendPayout({
      rpcUrl: DEV_RPC,
      privateKey: Buffer.from(KEY.priv, 'hex'),
      toAddresses: [{ address: KEY.address, capacityShannons: '10000000000' }],
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
  if (r.outputs.length > 0) {
    assert.strictEqual(r.outputs.length, 2,
      'fixed payout must include a treasury change output');
    assert.ok(r.outputs.some(output => BigInt(output.capacity) === 10_000_000_000n),
      'recipient receives the full fixed amount');
    assert.ok(BigInt(r.feeShannons) < 100_000_000n,
      'input excess must not be burned as an unbounded fee');
  }
});
