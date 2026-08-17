'use strict';
/** Operator wallet preflight, audited approval, and non-broadcasting sweep preview. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { createDb } = require('../src/accounting/db.js');
const {
  walletDoctor,
  approveBatch,
  walletSweepDryRun,
} = require('../src/accounting/poolctl.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const KEY = '0202020202020202020202020202020202020202020202020202020202020202';
const COLD = 'ckb1qyqt8xaupvm8837nv3gtc9x0ekkj64vud3jqfwyw5v';
const COLD_FULL = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4';
const EPOCH_ONE = '0x10000000001';

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

function keyFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  const file = path.join(dir, 'payout.privkey');
  fs.writeFileSync(file, KEY, { mode: 0o600 });
  return file;
}

function healthyDependencies() {
  return {
    async rpc(url, method) {
      if (method === 'get_tip_header') return { number: '0x64', epoch: EPOCH_ONE };
      if (method === 'get_indexer_tip') return { block_number: '0x63' };
      throw new Error(`unexpected ${url} ${method}`);
    },
    async collectLiveCellsFn() {
      return [{
        output: { capacity: '0x384' },
        out_point: { tx_hash: '0x' + '11'.repeat(32), index: '0x0' },
        block_number: '0x1',
        block_epoch: EPOCH_ONE,
        tx_index: '0x1',
      }];
    },
  };
}

test('wallet operator controls', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('doctor reports the derived address and never the key', async () => {
    const report = await walletDoctor({ db, env: { POOL_WALLET_KEY: keyFile() } });
    assert.match(report.key.address, /^ckb1/);
    assert.ok(!JSON.stringify(report).includes(KEY), 'private key must never reach doctor output');
  });

  await t.test('doctor reports missing key and unarmed state as findings, not crashes', async () => {
    const report = await walletDoctor({
      db,
      env: { POOL_WALLET_KEY: '/nonexistent/doctor-key' },
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.armed, false);
    assert.match(report.key.problem, /unreadable|key file/i);
    assert.match(report.note, /not armed/i);
  });

  await t.test('doctor reports invalid cold address without throwing', async () => {
    const report = await walletDoctor({
      db,
      env: {
        POOL_WALLET_KEY: keyFile(),
        POOL_WALLET_COLD_ADDRESS: 'ckb1qnonsense',
      },
    });
    assert.strictEqual(report.ok, false);
    assert.match(report.coldAddress.problem, /checksum|decode|invalid/i);
  });

  await t.test('healthy armed preflight measures live spendable surplus and indexer lag', async () => {
    await db.query(
      'TRUNCATE wallet_config, wallet_sweeps, treasury_receipts, ledger_entries, miners CASCADE');
    const report = await walletDoctor({
      db,
      env: {
        POOL_WALLET_KEY: keyFile(),
        POOL_WALLET_ARMED: '1',
        POOL_NODE_RPC: 'http://node:8114',
        POOL_INDEXER_URL: 'http://indexer:8114',
        POOL_WALLET_COLD_ADDRESS: COLD,
        POOL_WALLET_FLOAT_SHANNONS: '500',
      },
      ...healthyDependencies(),
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.armed, true);
    assert.strictEqual(report.node.indexerLag, 1);
    assert.strictEqual(report.limits.dailySpent, '0');
    assert.strictEqual(report.treasury.reconciledIncome, '0');
    assert.strictEqual(report.treasury.owedUnpaid, '0');
    assert.strictEqual(report.treasury.spendableShannons, '900');
    assert.strictEqual(report.treasury.sweepShannons, '400');
    assert.strictEqual(report.coldAddress.address, COLD);
  });

  await t.test('approve refuses a batch that is not HELD', async () => {
    await db.query('TRUNCATE payout_items, payout_batches CASCADE');
    const id = (await db.query(
      `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'CONFIRMED') RETURNING id`,
    )).rows[0].id;
    await assert.rejects(() => approveBatch(db, id, 'op'), /not HELD|HELD/i);
  });

  await t.test('approve transitions HELD to RESERVED and stamps the operator', async () => {
    await db.query('TRUNCATE payout_items, payout_batches CASCADE');
    const id = (await db.query(
      `INSERT INTO payout_batches (id, state, held_reason)
       VALUES (gen_random_uuid(), 'HELD', 'per-batch cap') RETURNING id`,
    )).rows[0].id;
    const result = await approveBatch(db, id, 'phill@console');
    const row = (await db.query(
      `SELECT state, released_by, released_at FROM payout_batches WHERE id = $1`, [id],
    )).rows[0];
    assert.strictEqual(result.batchId, String(id));
    assert.strictEqual(row.state, 'RESERVED');
    assert.strictEqual(row.released_by, 'phill@console');
    assert.ok(row.released_at);
  });

  await t.test('sweep dry-run reports the exact destination and amount without a broadcaster', async () => {
    await db.query('TRUNCATE wallet_config, wallet_sweeps, ledger_entries, miners CASCADE');
    const preview = await walletSweepDryRun({
      db,
      env: {
        POOL_WALLET_KEY: keyFile(),
        POOL_WALLET_ARMED: '1',
        POOL_NODE_RPC: 'http://node:8114',
        POOL_INDEXER_URL: 'http://indexer:8114',
        POOL_WALLET_COLD_ADDRESS: COLD,
        POOL_WALLET_FLOAT_SHANNONS: '500',
      },
      ...healthyDependencies(),
    });
    assert.deepStrictEqual(preview, {
      dryRun: true,
      broadcastNothing: true,
      coldAddress: COLD,
      spendableShannons: '900',
      floatShannons: '500',
      owedUnpaidShannons: '0',
      sweepShannons: '400',
    });
  });

  await t.test('sweep dry-run refuses a valid address that does not match the TOFU record', async () => {
    await db.query('TRUNCATE wallet_config, wallet_sweeps, ledger_entries, miners CASCADE');
    await db.query(`INSERT INTO wallet_config (id, cold_address) VALUES (1, $1)`, [COLD]);
    await assert.rejects(() => walletSweepDryRun({
      db,
      env: {
        POOL_WALLET_KEY: keyFile(),
        POOL_NODE_RPC: 'http://node:8114',
        POOL_INDEXER_URL: 'http://indexer:8114',
        POOL_WALLET_COLD_ADDRESS: COLD_FULL,
        POOL_WALLET_FLOAT_SHANNONS: '500',
      },
      ...healthyDependencies(),
    }), /cold address changed|TOFU|approve/i);
  });
});
