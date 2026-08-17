'use strict';
/**
 * A fresh deployment must not be able to move money. Unarmed wallets may
 * reserve an audited database batch, but only an armed wallet may enter the
 * builder/broadcast path.
 */
const test = require('node:test');
const assert = require('node:assert');
const { configurePayout, isArmed, runPayoutPass, runSweepPass } = require('../src/wallet/main.js');

const COLD = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';

test('unset is not armed', () => {
  assert.strictEqual(isArmed({}), false);
});

test('only the exact string "1" arms the wallet', () => {
  assert.strictEqual(isArmed({ POOL_WALLET_ARMED: '1' }), true);
  for (const value of ['0', '', 'true', 'yes', 'TRUE', ' 1', '1 ', 'armed']) {
    assert.strictEqual(isArmed({ POOL_WALLET_ARMED: value }), false,
      `"${value}" must not arm the wallet`);
  }
});

test('dry-run overrides arming', () => {
  assert.strictEqual(
    isArmed({ POOL_WALLET_ARMED: '1', POOL_WALLET_DRY_RUN: '1' }), false);
});

test('an unarmed payout pass may reserve a batch but cannot run the broadcaster', async () => {
  const calls = [];
  const worker = {
    async eligibleMiners() { calls.push('eligible'); return [{ miner_id: 'm1' }]; },
    async createBatch(miners) { calls.push(['create', miners]); return { state: 'RESERVED' }; },
    async runOnce() { calls.push('broadcast'); throw new Error('must not broadcast'); },
  };
  const metrics = {};

  const result = await runPayoutPass({ payoutWorker: worker, armed: false, metrics,
    logger: { log() {} } });

  assert.deepStrictEqual(calls, ['eligible', ['create', [{ miner_id: 'm1' }]]]);
  assert.deepStrictEqual(result, { state: 'RESERVED' });
  assert.strictEqual(metrics.payout_errors || 0, 0);
});

test('an armed payout pass uses the worker state machine', async () => {
  const calls = [];
  const worker = {
    async eligibleMiners() { calls.push('eligible'); return []; },
    async createBatch() { calls.push('create'); },
    async runOnce() { calls.push('runOnce'); return { state: 'BROADCAST' }; },
  };

  const result = await runPayoutPass({ payoutWorker: worker, armed: true,
    metrics: {}, logger: { log() {} } });

  assert.deepStrictEqual(calls, ['runOnce']);
  assert.deepStrictEqual(result, { state: 'BROADCAST' });
});

test('payout failures have an independent counter and do not escape the tick', async () => {
  const metrics = { rpc_errors: 3, snapshot_errors: 4, payout_errors: 0 };
  const logs = [];
  const result = await runPayoutPass({
    payoutWorker: { async runOnce() { throw new Error('node rejected payout'); } },
    armed: true,
    metrics,
    logger: { log: (...parts) => logs.push(parts.join(' ')) },
  });

  assert.strictEqual(result, null);
  assert.deepStrictEqual(metrics, { rpc_errors: 3, snapshot_errors: 4, payout_errors: 1 });
  assert.match(logs.join('\n'), /PAYOUT.*node rejected payout/i);
});

test('no loaded wallet means no payout work', async () => {
  const metrics = {};
  assert.strictEqual(await runPayoutPass({ payoutWorker: null, armed: true, metrics }), null);
  assert.strictEqual(metrics.payout_errors || 0, 0);
});

test('cold sweeps never run while the wallet is unarmed', async () => {
  let calls = 0;
  const result = await runSweepPass({
    sweepWorker: { async runOnce() { calls++; } },
    armed: false,
    metrics: {},
    logger: { log() {} },
  });
  assert.strictEqual(result, null);
  assert.strictEqual(calls, 0);
});

test('an armed wallet runs the cold sweep state machine', async () => {
  const expected = { state: 'BROADCAST', amountShannons: '100' };
  const result = await runSweepPass({
    sweepWorker: { async runOnce() { return expected; } },
    armed: true,
    metrics: {},
    logger: { log() {} },
  });
  assert.strictEqual(result, expected);
});

test('cold sweep failures have an independent metric and do not escape the tick', async () => {
  const metrics = { payout_errors: 2, sweep_errors: 0 };
  const logs = [];
  const result = await runSweepPass({
    sweepWorker: { async runOnce() { throw new Error('cold address changed'); } },
    armed: true,
    metrics,
    logger: { log: (...parts) => logs.push(parts.join(' ')) },
  });
  assert.strictEqual(result, null);
  assert.deepStrictEqual(metrics, { payout_errors: 2, sweep_errors: 1 });
  assert.match(logs.join('\n'), /SWEEP.*cold address changed/i);
});

test('no key configures reconciliation-only mode even if arming was requested', () => {
  const logs = [];
  const runtime = configurePayout({
    env: { POOL_WALLET_ARMED: '1' },
    db: {},
    nodeUrl: 'http://node',
    logger: { log: (...parts) => logs.push(parts.join(' ')) },
  });

  assert.deepStrictEqual(runtime, { keystore: null, payoutWorker: null, armed: false });
  assert.match(logs.join('\n'), /ignored.*no POOL_WALLET_KEY/i);
});

test('key configuration validates address and wires exact payout limits without logging key bytes', () => {
  const calls = [];
  const logs = [];
  const keyBytes = Buffer.alloc(32, 0xab);
  const env = {
    POOL_WALLET_KEY: '/secure/payout.privkey',
    POOL_WALLET_EXPECTED_ADDRESS: 'ckb1expected',
    POOL_WALLET_NETWORK: 'ckb',
    POOL_WALLET_ARMED: '1',
    POOL_INDEXER_URL: 'http://indexer',
    POOL_MIN_PAYOUT_SHANNONS: '11',
    POOL_WALLET_MAX_BATCH_SHANNONS: '22',
    POOL_WALLET_MAX_DAILY_SHANNONS: '33',
    POOL_WALLET_FEE_RATE_SHANNONS: '44',
    POOL_WALLET_COLD_ADDRESS: COLD,
    POOL_WALLET_FLOAT_SHANNONS: '55',
  };
  const fakeWorker = { stats: { insolvency: 0 } };
  const fakeSweepWorker = { name: 'sweep-worker' };
  const fakeBuilder = { name: 'builder' };
  const rpcClient = { rpc() {} };

  const runtime = configurePayout({
    env,
    db: { name: 'db' },
    nodeUrl: 'http://node',
    rpcClient,
    logger: { log: (...parts) => logs.push(parts.join(' ')) },
    loadKeystoreFn(options) {
      calls.push(['keystore', options]);
      return { privateKey: keyBytes, lock: {}, address: 'ckb1expected' };
    },
    createBuilderFn(options) {
      calls.push(['builder', options]);
      return fakeBuilder;
    },
    createWorkerFn(options) {
      calls.push(['worker', options]);
      return fakeWorker;
    },
    createSweepWorkerFn(options) {
      calls.push(['sweep', options]);
      return fakeSweepWorker;
    },
  });

  assert.strictEqual(runtime.armed, true);
  assert.strictEqual(runtime.keystore.address, 'ckb1expected');
  assert.strictEqual(runtime.payoutWorker, fakeWorker);
  assert.strictEqual(runtime.sweepWorker, fakeSweepWorker);
  assert.deepStrictEqual(calls[0], ['keystore', {
    keyPath: '/secure/payout.privkey', expectedAddress: 'ckb1expected', network: 'ckb',
  }]);
  assert.strictEqual(calls[1][1].privateKey, keyBytes);
  assert.deepStrictEqual(
    { rpcUrl: calls[1][1].rpcUrl, indexerUrl: calls[1][1].indexerUrl,
      feeRateShannons: calls[1][1].feeRateShannons },
    { rpcUrl: 'http://node', indexerUrl: 'http://indexer', feeRateShannons: 44 });
  assert.deepStrictEqual(calls[2][1].limits,
    { maxBatchShannons: '22', maxDailyShannons: '33' });
  assert.strictEqual(calls[2][1].minimumPayoutShannons, '11');
  assert.strictEqual(calls[2][1].rpcClient, rpcClient);
  assert.deepStrictEqual(
    { coldAddress: calls[3][1].coldAddress,
      floatShannons: calls[3][1].floatShannons,
      network: calls[3][1].network,
      rpcClient: calls[3][1].rpcClient,
      txBuilder: calls[3][1].txBuilder },
    { coldAddress: COLD, floatShannons: '55', network: 'ckb', rpcClient,
      txBuilder: fakeBuilder });
  assert.match(logs.join('\n'), /ckb1expected.*armed=true/);
  assert.ok(!logs.join('\n').includes(keyBytes.toString('hex')), 'private key must never be logged');
});
