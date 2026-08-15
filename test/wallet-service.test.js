'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildMetrics, HELP_BUILD } = require('../src/wallet/main.js');

test('metrics carry the build stamp so check-stale.sh covers this service', () => {
  const out = buildMetrics({ ticks: 3, receipts_recorded: 2, receipts_confirmed: 1,
                             receipts_voided: 0, rpc_errors: 0 });
  assert.match(out, /pool_build_info\{commit="[0-9a-f]{40}",started_at="[^"]+"\} 1/);
  assert.ok(out.includes(HELP_BUILD));
});

test('metrics expose reconciliation counters', () => {
  const out = buildMetrics({ ticks: 3, receipts_recorded: 2, receipts_confirmed: 1,
                             receipts_voided: 4, rpc_errors: 7 });
  assert.match(out, /pool_wallet_receipts_recorded_total 2/);
  assert.match(out, /pool_wallet_receipts_confirmed_total 1/);
  assert.match(out, /pool_wallet_receipts_voided_total 4/);
  assert.match(out, /pool_wallet_rpc_errors_total 7/);
});

test('this plan ships no signing path', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../src/wallet/main.js'), 'utf8');
  for (const forbidden of ['privateKey', 'send_transaction', 'sign(', 'POOL_WALLET_KEY']) {
    assert.ok(!src.includes(forbidden),
      `Plan 1 must not be able to move funds; found "${forbidden}"`);
  }
});
