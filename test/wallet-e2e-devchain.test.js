'use strict';
/** Real-node payout gate: accepted output, committed transaction, settled ledger. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const { createDb } = require('../src/accounting/db.js');
const { createPayoutWorker } = require('../src/wallet/payout-worker.js');
const { createCkbInProcessBuilder } = require('../src/wallet/tx-builder-inprocess.js');
const { deriveLock, lockToAddress } = require('../src/wallet/keystore.js');
const { postEntry, balanceFor, verifyBlockConservation, ACCOUNTS } = require('../src/accounting/ledger.js');
const merkle = require('../src/mining/ckb-merkle.js');
const { minimalNonceHex } = require('../src/edge/block-submitter.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const DEV_RPC = process.env.POOL_DEV_NODE_RPC || process.env.DEV_RPC || 'http://127.0.0.1:8115';
const KEY_FILE = process.env.POOL_DEV_KEY_FILE || '/tmp/opencode/pool-key.json';
const REQUIRED = process.env.POOL_REQUIRE_DEV_CHAIN === '1';
const PAYOUT = '70000000000';

let ready = false;
try {
  const health = JSON.parse(execFileSync('curl', [
    '-s', '--max-time', '2', DEV_RPC, '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-d', '{"id":1,"jsonrpc":"2.0","method":"get_tip_header","params":[]}',
  ], { encoding: 'utf8' }));
  if (!health.result) throw new Error('dev node returned no tip');
  execFileSync('docker', ['exec', 'pool-pg-test', 'pg_isready', '-U', 'pool'], { stdio: 'ignore' });
  ready = fs.existsSync(KEY_FILE);
} catch { ready = false; }

function rpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const request = http.request({
      host: endpoint.hostname,
      port: endpoint.port || 8114,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          const message = JSON.parse(data);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`RPC timeout: ${method}`)));
    request.on('error', reject);
    request.end(body);
  });
}

async function mineBlock() {
  const template = await rpc(DEV_RPC, 'get_block_template', [null, null, null]);
  const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(32, '0');
  const block = merkle.buildBlockForSubmit(template, minimalNonceHex('0x' + random));
  await rpc(DEV_RPC, 'submit_block', [template.work_id, block]);
}

async function waitForCommitted(txHash) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const observed = await rpc(DEV_RPC, 'get_transaction', [txHash]);
    if (observed?.tx_status?.status === 'committed') return observed;
    await mineBlock();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const last = await rpc(DEV_RPC, 'get_transaction', [txHash]);
  throw new Error(`transaction ${txHash} did not commit; last status ${last?.tx_status?.status || 'absent'}`);
}

function sameLock(left, right) {
  return left?.code_hash === right.code_hash &&
    left?.hash_type === right.hash_type && left?.args === right.args;
}

if (REQUIRED && !ready) {
  test('end-to-end payout prerequisites', () => {
    assert.fail(`dev chain/database/key unavailable; run deploy/ckb-dev-test.sh and deploy/pg-test.sh (${DEV_RPC}, ${KEY_FILE})`);
  });
} else {
  test('end-to-end payout is accepted and settled by a real CKB node', {
    timeout: 300000,
    skip: !ready,
  }, async t => {
    const db = createDb(DB_URL);
    t.after(() => db.close());
    await db.migrate(MIGRATIONS);

    // Commit any payout left pending by a prior drill before selecting inputs.
    for (let index = 0; index < 4; index++) await mineBlock();
    await db.query(
      `TRUNCATE wallet_sweeps, wallet_config, payout_items, payout_batches,
                ledger_entries, treasury_receipts, blocks, miners CASCADE`,
    );

    const poolKey = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    const recipientLock = deriveLock(Buffer.alloc(32, 3));
    const recipientAddress = lockToAddress(recipientLock, 'ckt');
    const minerId = String((await db.query(
      `INSERT INTO miners (payout_address, network) VALUES ($1, 'ckt') RETURNING id`,
      [recipientAddress],
    )).rows[0].id);
    const blockId = String((await db.query(
      `INSERT INTO blocks
         (edge_id, boot_id, job_id, nonce, height, block_hash, state, reward_shannons)
       VALUES ('e2e', gen_random_uuid(), 'wallet-e2e', '0x1', 1, $1, 'ALLOCATED', $2)
       RETURNING id`,
      ['0x' + '55'.repeat(32), PAYOUT],
    )).rows[0].id);
    await db.query(
      `INSERT INTO treasury_receipts
         (block_id, block_height, payout_block_height, payout_tx_hash,
          output_index, lock_args, amount_shannons, mature_at_epoch, confirmed_at)
       VALUES ($1, 1, 12, $2, 0, $3, $4, 1, now())`,
      [blockId, '0x' + '66'.repeat(32), '0x' + poolKey.blake160, PAYOUT],
    );
    await postEntry(db, {
      accountType: ACCOUNTS.CONFIRMED,
      minerId,
      amountShannons: PAYOUT,
      referenceType: 'block',
      referenceId: blockId,
      idempotencyKey: `e2e:block:${blockId}:miner:${minerId}`,
    });

    const txBuilder = createCkbInProcessBuilder({
      rpcUrl: DEV_RPC,
      privateKey: Buffer.from(poolKey.priv, 'hex'),
      feeRateShannons: 1000,
      logger: { log() {} },
    });
    const worker = createPayoutWorker({
      db,
      txBuilder,
      minimumPayoutShannons: '6100000000',
      limits: {
        maxBatchShannons: '100000000000',
        maxDailyShannons: '1000000000000',
      },
      logger: { log() {} },
    });

    const eligible = await worker.eligibleMiners();
    assert.strictEqual(eligible.length, 1);
    const batch = await worker.createBatch(eligible);
    assert.strictEqual(batch.state, 'RESERVED');
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), '0');
    assert.strictEqual(
      (await balanceFor(db, minerId, [ACCOUNTS.PENDING_PAYOUT])).toString(), PAYOUT,
      'reservation must move the liability to pending before any broadcast',
    );
    const txHash = await worker.processBatch(batch.batchId);
    assert.match(txHash, /^0x[0-9a-f]{64}$/);
    assert.strictEqual((await db.query(
      `SELECT state FROM payout_batches WHERE id = $1`, [batch.batchId],
    )).rows[0].state, 'BROADCAST');

    const committed = await waitForCommitted(txHash);
    assert.strictEqual(committed.tx_status.status, 'committed');
    t.diagnostic(`real CKB node committed payout ${txHash}`);
    const paid = committed.transaction.outputs
      .filter(output => sameLock(output.lock, recipientLock))
      .reduce((sum, output) => sum + BigInt(output.capacity), 0n);
    assert.strictEqual(paid.toString(), PAYOUT, 'recipient must receive the exact fixed payout');

    const node = { rpc: (method, params) => rpc(DEV_RPC, method, params) };
    assert.strictEqual(await worker.confirmBatch(batch.batchId, node), true);
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.CONFIRMED])).toString(), '0');
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.PENDING_PAYOUT])).toString(), '0');
    assert.strictEqual((await balanceFor(db, minerId, [ACCOUNTS.PAID])).toString(), PAYOUT);
    const fee = String((await db.query(
      `SELECT COALESCE(sum(amount_shannons), 0) AS fee
         FROM ledger_entries WHERE account_type = $1`, [ACCOUNTS.TX_FEE],
    )).rows[0].fee);
    assert.ok(BigInt(fee) > 0n, 'the committed transaction fee must be booked');
    t.diagnostic(`committed fee booked: ${fee} shannons`);
    assert.strictEqual(await verifyBlockConservation(db, blockId, PAYOUT), true);
    assert.strictEqual((await db.query(
      `SELECT state FROM payout_batches WHERE id = $1`, [batch.batchId],
    )).rows[0].state, 'CONFIRMED');
  });
}
