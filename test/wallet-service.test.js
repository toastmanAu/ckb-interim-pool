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

test('only the keystore may reference key bytes; no wallet module may sign or broadcast yet', () => {
  // Task 1 introduces key loading but no spending path. Keep the exception
  // symbol-specific so adding signing or broadcast capability still requires
  // a deliberate guard change when the transaction builder moves in Task 6.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.dirname(require.resolve('../src/wallet/main.js'));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  const permitted = { privateKey: new Set(['keystore.js']) };

  assert.ok(files.length >= 4, `expected the wallet directory to be scanned, saw ${files.length} file(s)`);
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const forbidden of ['privateKey', 'send_transaction', 'sign(', 'POOL_WALLET_KEY']) {
      if (permitted[forbidden]?.has(file)) continue;
      assert.ok(!src.includes(forbidden),
        `wallet must not be able to move funds; found "${forbidden}" in src/wallet/${file}`);
    }
  }
});
