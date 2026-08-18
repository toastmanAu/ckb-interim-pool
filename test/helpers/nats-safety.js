'use strict';

/**
 * Refuse to run the destructive NATS outage test against a shared/live bus.
 * The test intentionally restarts its server, so both the stream inventory and
 * subject namespace must be isolated before it may proceed.
 */
function assertIsolatedTestServer(streams, { stream, subjects, allowOutage }) {
  if (allowOutage !== '1') {
    throw new Error('refusing outage test: set POOL_NATS_ALLOW_OUTAGE_TEST=1 for a dedicated test server');
  }
  if (!stream || !stream.endsWith('_TEST')) {
    throw new Error(`refusing outage test: stream ${stream || '(missing)'} is not test-only`);
  }
  if (!Array.isArray(subjects) || subjects.length === 0 ||
      subjects.some(subject => !subject.startsWith('pool.v1.test.'))) {
    throw new Error('refusing outage test: subjects must use the isolated test namespace pool.v1.test.*');
  }

  const foreign = streams
    .map(info => info?.config?.name)
    .filter(name => name && !name.endsWith('_TEST'));
  if (foreign.length > 0) {
    throw new Error(`refusing outage test: NATS server contains foreign stream(s): ${foreign.join(', ')}`);
  }
}

module.exports = { assertIsolatedTestServer };
