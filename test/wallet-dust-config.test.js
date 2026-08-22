'use strict';
/**
 * Dust and forfeiture policy reaches the payout worker from the environment,
 * and forfeiture stays off unless an operator turns it on deliberately.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { configurePayout } = require('../src/wallet/main.js');

const quiet = { log: () => {} };

function capturedOptions(env) {
  let captured = null;
  configurePayout({
    env: { POOL_WALLET_KEY: '/dev/null', ...env },
    db: {}, nodeUrl: 'http://127.0.0.1:8114', logger: quiet,
    loadKeystoreFn: () => ({ privateKey: Buffer.alloc(32, 1), address: 'ckb1qtest' }),
    createBuilderFn: () => ({}),
    createWorkerFn: (opts) => { captured = opts; return {}; },
    createSweepWorkerFn: () => ({}),
  });
  return captured;
}

test('forfeiture is off unless the operator sets a dormancy period', () => {
  assert.strictEqual(capturedOptions({}).forfeitAfterDays, 0);
});

test('the dust clock defaults to three days', () => {
  assert.strictEqual(capturedOptions({}).dustInactiveDays, 3);
});

test('both policies are configurable from the environment', () => {
  const opts = capturedOptions({ POOL_DUST_INACTIVE_DAYS: '5', POOL_DUST_FORFEIT_DAYS: '90' });
  assert.deepStrictEqual(
    { dust: opts.dustInactiveDays, forfeit: opts.forfeitAfterDays }, { dust: 5, forfeit: 90 });
});

test('a non-numeric policy value is refused rather than silently becoming NaN', () => {
  assert.throws(() => capturedOptions({ POOL_DUST_INACTIVE_DAYS: 'soon' }),
    /POOL_DUST_INACTIVE_DAYS/);
  assert.throws(() => capturedOptions({ POOL_DUST_FORFEIT_DAYS: 'never' }),
    /POOL_DUST_FORFEIT_DAYS/);
});

test('the shipped unit file leaves forfeiture disabled', () => {
  const unit = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'systemd', 'pool-wallet.service'), 'utf8');
  assert.match(unit, /^Environment=POOL_DUST_FORFEIT_DAYS=0$/m);
  assert.match(unit, /^Environment=POOL_DUST_INACTIVE_DAYS=3$/m);
});

const { buildMetrics } = require('../src/wallet/main.js');

test('forfeited value is exported as a monotonic counter', () => {
  const out = buildMetrics({ forfeited_shannons: 5000000000 });
  assert.match(out, /# TYPE pool_wallet_forfeited_shannons_total counter/);
  assert.match(out, /pool_wallet_forfeited_shannons_total 5000000000/);
});

test('the forfeited counter reads zero rather than undefined when nothing has been forfeited', () => {
  assert.match(buildMetrics({}), /pool_wallet_forfeited_shannons_total 0/);
});
