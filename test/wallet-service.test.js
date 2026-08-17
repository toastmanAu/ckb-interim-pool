'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildMetrics, HELP_BUILD } = require('../src/wallet/main.js');

test('metrics carry the build stamp so check-stale.sh covers this service', () => {
  const out = buildMetrics({ ticks: 3, rpc_errors: 0 },
                           { total: 2, confirmed: 1, pending: 1, voided: 0 });
  assert.match(out, /pool_build_info\{commit="[0-9a-f]{40}",started_at="[^"]+"\} 1/);
  assert.ok(out.includes(HELP_BUILD));
});

test('receipt gauges report database state, not an in-process accumulator', () => {
  const out = buildMetrics({ ticks: 3, rpc_errors: 7 },
                           { total: 9, confirmed: 4, pending: 3, voided: 2 });
  assert.match(out, /pool_wallet_receipts_total 9/);
  assert.match(out, /pool_wallet_receipts_confirmed 4/);
  assert.match(out, /pool_wallet_receipts_pending 3/);
  assert.match(out, /pool_wallet_receipts_voided 2/);
  assert.match(out, /pool_wallet_ticks_total 3/);
  assert.match(out, /pool_wallet_rpc_errors_total 7/);
});

test('receipt metrics are typed as gauges, not counters', () => {
  const out = buildMetrics({ ticks: 0, rpc_errors: 0 },
                           { total: 0, confirmed: 0, pending: 0, voided: 0 });
  assert.match(out, /# TYPE pool_wallet_receipts_confirmed gauge/);
  assert.ok(!/pool_wallet_receipts_confirmed_total/.test(out),
    'a _total suffix would assert a monotonic counter, which these are not');
});

test('payout and insolvency failures have distinct metrics', () => {
  const out = buildMetrics({ payout_errors: 2, insolvency: 3 });
  assert.match(out, /pool_wallet_payout_errors_total 2/);
  assert.match(out, /pool_wallet_insolvency_total 3/);
});

test('wallet unit is unarmed by default and retains key-host hardening', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const unit = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'systemd', 'pool-wallet.service'), 'utf8');
  for (const line of [
    'User=pool-wallet',
    'Environment=POOL_WALLET_ARMED=0',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'PrivateTmp=true',
    'NoNewPrivileges=true',
    'MemoryDenyWriteExecute=yes',
    'LimitCORE=0',
  ]) {
    assert.ok(unit.includes(line), `wallet unit must contain ${line}`);
  }
});

test('only designated wallet modules may reference key or signing material', () => {
  // Task 4 moves the existing payout builders into the wallet boundary. Keep
  // an exact allowlist so a new signing-capable module requires review.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.dirname(require.resolve('../src/wallet/main.js'));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  const maySign = new Set([
    'keystore.js',
    'main.js',
    'tx-builder.js',
    'tx-builder-inprocess.js',
    'tx-builder-stub.js',
  ]);

  assert.ok(files.length >= 4, `expected the wallet directory to be scanned, saw ${files.length} file(s)`);
  for (const file of files) {
    if (maySign.has(file)) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const forbidden of ['privateKey', 'send_transaction', 'sign(', 'POOL_WALLET_KEY']) {
      assert.ok(!src.includes(forbidden),
        `non-signing wallet module referenced "${forbidden}" in src/wallet/${file}`);
    }
  }
});
