'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assertIsolatedTestServer } = require('./helpers/nats-safety.js');

test('NATS outage test refuses a server containing a production stream', () => {
  const streams = [
    { config: { name: 'POOL_V1', subjects: ['pool.v1.edge.>'] } },
  ];

  assert.throws(
    () => assertIsolatedTestServer(streams, {
      stream: 'POOL_V1_TEST',
      subjects: ['pool.v1.test.edge.>'],
      allowOutage: '1',
    }),
    /refusing outage test.*POOL_V1/i,
  );
});

test('NATS outage test accepts an empty or self-owned isolated server', () => {
  const config = {
    stream: 'POOL_V1_TEST',
    subjects: ['pool.v1.test.edge.>'],
    allowOutage: '1',
  };

  assert.doesNotThrow(() => assertIsolatedTestServer([], config));
  assert.doesNotThrow(() => assertIsolatedTestServer([
    { config: { name: 'POOL_V1_TEST', subjects: ['pool.v1.test.edge.>'] } },
    { config: { name: 'POOL_V1_ACCT_TEST', subjects: ['pool.v1.accttest.>'] } },
  ], config));
});

test('NATS outage test refuses the production subject namespace', () => {
  assert.throws(
    () => assertIsolatedTestServer([], {
      stream: 'POOL_V1_TEST',
      subjects: ['pool.v1.edge.>'],
      allowOutage: '1',
    }),
    /isolated test namespace/i,
  );
});

test('NATS outage test requires explicit destructive-test opt-in', () => {
  assert.throws(
    () => assertIsolatedTestServer([], {
      stream: 'POOL_V1_TEST',
      subjects: ['pool.v1.test.edge.>'],
    }),
    /POOL_NATS_ALLOW_OUTAGE_TEST=1/,
  );
});
