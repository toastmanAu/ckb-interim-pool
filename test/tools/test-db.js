'use strict';
/**
 * test-db.js — the database integration tests are allowed to destroy.
 *
 * Every DB suite starts by TRUNCATE-ing the pool tables. That is fine against
 * a throwaway CI database and catastrophic against the live session database,
 * which holds the only record of shares owed to miners and blocks won.
 *
 * On 2026-08-15 `npm run test:db` was run without POOL_DB_URL set. The suites
 * defaulted to the LIVE `pooltest` database and truncated it — 688 share
 * events and two won mainnet blocks, gone. (They were rebuilt by replaying the
 * edge spool WAL, which is the only reason this was recoverable.) Commit
 * 2687720 had already created `pooltest_ci` for exactly this reason, but
 * nothing made the tests actually use it, so the protection never engaged.
 *
 * Two layers, because a default alone is not a guard — anyone exporting
 * POOL_DB_URL for a debugging session walks straight past it:
 *
 *   1. default to the CI database rather than the live one;
 *   2. REFUSE to run destructive suites against any database that is not
 *      explicitly marked disposable.
 */

const DEFAULT_CI_URL = 'postgres://pool:pooltest@127.0.0.1:5433/pooltest_ci';

/** Databases a destructive test suite may truncate. */
const DISPOSABLE = /(_ci|_test|_tmp)$/;

function databaseName(url) {
  // postgres://user:pass@host:port/dbname?opts
  const m = /^[^:]+:\/\/[^/]+\/([^?]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Resolve the URL for a suite that TRUNCATEs. Throws rather than let a run
 * destroy live data.
 *
 * Escape hatch: POOL_ALLOW_DESTRUCTIVE_DB=1 for the rare deliberate case
 * (e.g. rebuilding a scratch database that is not named to the convention).
 */
function destructiveDbUrl() {
  const url = process.env.POOL_DB_URL || DEFAULT_CI_URL;
  const name = databaseName(url);

  if (!DISPOSABLE.test(name) && process.env.POOL_ALLOW_DESTRUCTIVE_DB !== '1') {
    throw new Error(
      `refusing to run destructive tests against database "${name}": these ` +
      `suites TRUNCATE the pool tables, and "${name}" is not named as ` +
      `disposable (${DISPOSABLE}). Use ${DEFAULT_CI_URL} (deploy/pg-test.sh ` +
      `creates it), or set POOL_ALLOW_DESTRUCTIVE_DB=1 if you genuinely mean ` +
      `to wipe it.`,
    );
  }
  return url;
}

module.exports = { destructiveDbUrl, databaseName, DEFAULT_CI_URL, DISPOSABLE };
