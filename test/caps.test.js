'use strict';
/** Capped autonomy: refuse the whole batch; never trim it into cap-sized pieces. */
const test = require('node:test');
const assert = require('node:assert');
const { capVerdict, dailySpentShannons } = require('../src/wallet/caps.js');

const LIMITS = {
  maxBatchShannons: '200000000000',
  maxDailyShannons: '1000000000000',
};

test('a batch within every cap is allowed', () => {
  assert.deepStrictEqual(capVerdict({
    batchTotal: '100000000000', dailySpent: '0',
    perMiner: [{ minerId: 'm1', amount: '100000000000', owed: '100000000000' }],
    limits: LIMITS,
  }), { allowed: true, reason: null });
});

test('a batch over the per-batch cap is refused rather than trimmed', () => {
  const verdict = capVerdict({
    batchTotal: '200000000001', dailySpent: '0',
    perMiner: [{ minerId: 'm1', amount: '200000000001', owed: '200000000001' }],
    limits: LIMITS,
  });
  assert.strictEqual(verdict.allowed, false);
  assert.match(verdict.reason, /per-batch/i);
});

test('the rolling daily cap includes value already broadcast', () => {
  const verdict = capVerdict({
    batchTotal: '100000000000', dailySpent: '950000000000',
    perMiner: [{ minerId: 'm1', amount: '100000000000', owed: '100000000000' }],
    limits: LIMITS,
  });
  assert.strictEqual(verdict.allowed, false);
  assert.match(verdict.reason, /24h|daily/i);
});

test('exactly at both caps is allowed', () => {
  assert.strictEqual(capVerdict({
    batchTotal: '200000000000', dailySpent: '800000000000',
    perMiner: [{ minerId: 'm1', amount: '200000000000', owed: '200000000000' }],
    limits: LIMITS,
  }).allowed, true);
});

test('paying a miner more than their aggregate debt is refused', () => {
  const verdict = capVerdict({
    batchTotal: '100', dailySpent: '0',
    perMiner: [
      { minerId: 'm1', amount: '60', owed: '99' },
      { minerId: 'm1', amount: '40', owed: '99' },
    ],
    limits: LIMITS,
  });
  assert.strictEqual(verdict.allowed, false,
    'duplicate item rows must not each compare independently to the same debt');
  assert.match(verdict.reason, /owed/i);
});

test('the declared total must equal the sum of miner items', () => {
  const verdict = capVerdict({
    batchTotal: '1', dailySpent: '0',
    perMiner: [{ minerId: 'm1', amount: '200000000001', owed: '200000000001' }],
    limits: LIMITS,
  });
  assert.strictEqual(verdict.allowed, false);
  assert.match(verdict.reason, /total|sum/i);
});

test('caps use BigInt beyond Number.MAX_SAFE_INTEGER', () => {
  const verdict = capVerdict({
    batchTotal: '9007199254740993', dailySpent: '0',
    perMiner: [{ minerId: 'm1', amount: '9007199254740993', owed: '9007199254740993' }],
    limits: {
      maxBatchShannons: '9007199254740992',
      maxDailyShannons: '99999999999999999',
    },
  });
  assert.strictEqual(verdict.allowed, false, 'one shannon over the cap must be refused');
});

test('negative monetary values are rejected as invalid state', () => {
  assert.throws(() => capVerdict({
    batchTotal: '-1', dailySpent: '0', perMiner: [], limits: LIMITS,
  }), /negative|non-negative/i);
  assert.throws(() => capVerdict({
    batchTotal: '0', dailySpent: '-1', perMiner: [], limits: LIMITS,
  }), /negative|non-negative/i);
});

test('daily spend is derived from broadcast batch items', async () => {
  let sql = null;
  const db = {
    async query(statement) {
      sql = statement;
      return { rows: [{ spent: '12345678901234567890' }] };
    },
  };
  assert.strictEqual(await dailySpentShannons(db), '12345678901234567890');
  assert.match(sql, /broadcast_at\s+IS NOT NULL/i);
  assert.match(sql, /interval\s+'24 hours'/i);
  assert.match(sql, /sum\(i\.amount_shannons\)/i);
});
