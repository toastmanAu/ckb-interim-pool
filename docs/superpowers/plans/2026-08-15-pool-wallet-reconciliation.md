# pool-wallet Plan 1: Income Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pool know what it actually earned, by reconciling each mined block against the on-chain payment it received 11 blocks later.

**Architecture:** A new long-running `pool-wallet` service reads each canonical block's cellbase *witness* to learn the miner lock that block used, finds the matching cellbase output in block H+11, and records the real amount in `treasury_receipts`. Accounting stops guessing the reward from the wrong block's cellbase and reads the reconciled figure instead. This plan handles **no signing key and cannot move funds** — payouts, caps and sweeps are Plan 2.

**Tech Stack:** Node.js 22 (CommonJS, no build step), `node:test` + `node:assert`, PostgreSQL via `pg`, CKB JSON-RPC over plain `http`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-15-pool-wallet-design.md`

## Global Constraints

- Node.js 22, CommonJS (`require`), `'use strict'` at the top of every file — match existing `src/` style
- No new runtime dependencies. Reuse `src/edge/rpc.js`, `src/mining/ckb-header.js` (`parseEpoch`), `src/accounting/db.js`
- CKB reward delay is **11 blocks**; cellbase maturity is **4 epochs**. Both are named constants, never inline literals
- Every new service exposes `pool_build_info` from `src/common/build-info.js` so `deploy/check-stale.sh` covers it
- DB integration tests use `test/tools/test-db.js` → `destructiveDbUrl()`. Never hardcode a database URL; the suites refuse any database not named disposable
- Money-adjacent numbers are `BigInt` or decimal strings end-to-end. Never `Number` for shannons
- This plan must not introduce any code path that constructs, signs, or broadcasts a transaction

---

## File Structure

| File | Responsibility |
|---|---|
| `src/wallet/cellbase-witness.js` (new) | Parse the `CellbaseWitness` molecule → `{lock, message}`. Pure, bounds-checked |
| `src/wallet/reconciler.js` (new) | Match a block to its H+11 payment; persist, confirm, void on reorg |
| `src/wallet/treasury.js` (new) | Balance snapshots per lock seen in receipts |
| `src/wallet/main.js` (new) | Service entry: tick loop, metrics, health, shutdown |
| `db/migrations/003-treasury.sql` (new) | `treasury_receipts`, `treasury_snapshots`, `wallet_config` |
| `src/accounting/block-tracker.js` (modify) | Stop extracting `reward_shannons` |
| `src/accounting/allocator.js` (modify) | Read reward from `treasury_receipts` |
| `src/accounting/poolctl.js` (modify) | `wallet status` / `wallet receipts` |
| `deploy/systemd/pool-wallet.service` (new) | Unit, hardened, `Restart=always` |
| `test/fixtures/treasury-receipts-mainnet.json` (new) | Recorded H/H+11 pairs from mainnet |

---

## Task 1: CellbaseWitness molecule parser

**Files:**
- Create: `src/wallet/cellbase-witness.js`
- Test: `test/cellbase-witness.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `parseCellbaseWitness(witnessHex) -> { lock: {code_hash, hash_type, args}, message }` where all three lock fields are `0x`-prefixed strings except `hash_type` which is `'data'|'type'|'data1'|'data2'`. Throws on malformed input.

- [ ] **Step 1: Write the failing test**

```javascript
// test/cellbase-witness.test.js
'use strict';
/**
 * cellbase-witness.test.js — the CellbaseWitness molecule records which lock
 * mined a block. Block N+11 pays that lock, so this parse is what attributes
 * income to the right wallet. Pinned against a real mainnet block the pool won.
 */
const test = require('node:test');
const assert = require('node:assert');
const { parseCellbaseWitness } = require('../src/wallet/cellbase-witness.js');

// block 20152836, won by this pool 2026-08-14 (149 bytes / 298 hex chars)
const REAL = '0x' +
  '950000000c00000055000000490000001000000030000000310000009bd7e06f' +
  '3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce801140000' +
  '005ea0977c3cab6898817c9860fe70d26acf559f763c0000000000000020302e' +
  '3230392e3020286431363665323820323032362d30372d323929206d696e6564' +
  '2062792077796c74656b20696e6475737472696573';

test('parses the lock from a real mainnet cellbase witness', () => {
  const { lock } = parseCellbaseWitness(REAL);
  assert.strictEqual(lock.code_hash,
    '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8');
  assert.strictEqual(lock.hash_type, 'type');
  assert.strictEqual(lock.args, '0x5ea0977c3cab6898817c9860fe70d26acf559f76');
});

test('rejects a truncated witness rather than returning a partial lock', () => {
  assert.throws(() => parseCellbaseWitness(REAL.slice(0, 40)), /molecule/i);
});

test('rejects a table whose declared size disagrees with the buffer', () => {
  // full_size says 0xff bytes, buffer is far shorter
  assert.throws(() => parseCellbaseWitness('0xff0000000c00000010000000'), /molecule/i);
});

test('rejects an offset pointing past the end', () => {
  // full_size 12, first offset 0xffff
  assert.throws(() => parseCellbaseWitness('0x0c000000ffff0000'), /molecule/i);
});
```

**On the fixture string:** the `REAL` constant is verified — 298 hex characters
(149 bytes) after stripping `0x`. If it is ever edited, re-check the length
first; a single stray character silently changes which lock the test asserts.
Regenerate by fetching `get_block_by_number` for height 20152836 and taking
`transactions[0].witnesses[0]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cellbase-witness.test.js`
Expected: FAIL — `Cannot find module '../src/wallet/cellbase-witness.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/wallet/cellbase-witness.js
'use strict';
/**
 * cellbase-witness.js — parse the CellbaseWitness molecule.
 *
 *   CellbaseWitness = table { lock: Script, message: Bytes }
 *   Script          = table { code_hash: Byte32, hash_type: byte, args: Bytes }
 *
 * Why this exists: a CKB cellbase in block N pays the miner of block N-11, and
 * the lock to pay is read from block N-11's cellbase witness. So this witness
 * — not our config — is the authoritative record of which wallet earned a
 * block. Reading it here means a later `block_assembler` change (as happened
 * 2026-08-15) cannot misattribute historical income.
 *
 * Molecule table layout: u32 full_size | u32 offset[0..n-1] | fields.
 * Every read is bounds-checked: this parses chain data, and a decoder that
 * trusts its length prefixes is how out-of-bounds reads happen.
 */

const HASH_TYPE = { 0: 'data', 1: 'type', 2: 'data1', 4: 'data2' };

function u32le(buf, off) {
  if (off < 0 || off + 4 > buf.length) {
    throw new Error(`molecule: u32 read at ${off} past end (${buf.length})`);
  }
  return buf.readUInt32LE(off);
}

/** Field boundaries of a molecule table, with the buffer end appended. */
function tableOffsets(buf) {
  if (buf.length < 8) throw new Error(`molecule: table too short (${buf.length})`);
  const full = u32le(buf, 0);
  if (full !== buf.length) {
    throw new Error(`molecule: declared size ${full} != buffer ${buf.length}`);
  }
  const first = u32le(buf, 4);
  if (first < 8 || first > buf.length || first % 4 !== 0) {
    throw new Error(`molecule: bad first offset ${first}`);
  }
  const count = (first - 4) / 4;
  const offs = [];
  for (let i = 0; i < count; i++) {
    const o = u32le(buf, 4 + 4 * i);
    if (o > buf.length) throw new Error(`molecule: offset ${o} past end (${buf.length})`);
    if (i > 0 && o < offs[i - 1]) throw new Error('molecule: offsets not monotonic');
    offs.push(o);
  }
  offs.push(buf.length);
  return offs;
}

/** A molecule Bytes field: u32 length prefix followed by that many bytes. */
function readBytesField(field, what) {
  const len = u32le(field, 0);
  if (4 + len !== field.length) {
    throw new Error(`molecule: ${what} length ${len} != field payload ${field.length - 4}`);
  }
  return field.subarray(4);
}

function parseScript(buf) {
  const o = tableOffsets(buf);
  if (o.length < 4) throw new Error('molecule: Script needs 3 fields');
  const codeHash = buf.subarray(o[0], o[1]);
  if (codeHash.length !== 32) {
    throw new Error(`molecule: Script.code_hash must be 32 bytes, got ${codeHash.length}`);
  }
  const ht = buf.subarray(o[1], o[2]);
  if (ht.length !== 1) {
    throw new Error(`molecule: Script.hash_type must be 1 byte, got ${ht.length}`);
  }
  const hashType = HASH_TYPE[ht[0]];
  if (!hashType) throw new Error(`molecule: unknown hash_type ${ht[0]}`);
  return {
    code_hash: '0x' + codeHash.toString('hex'),
    hash_type: hashType,
    args: '0x' + readBytesField(buf.subarray(o[2], o[3]), 'Script.args').toString('hex'),
  };
}

function parseCellbaseWitness(witnessHex) {
  const hex = String(witnessHex).replace(/^0x/, '');
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('molecule: witness is not valid hex');
  }
  const buf = Buffer.from(hex, 'hex');
  const o = tableOffsets(buf);
  if (o.length < 3) throw new Error('molecule: CellbaseWitness needs 2 fields');
  return {
    lock: parseScript(buf.subarray(o[0], o[1])),
    message: '0x' + readBytesField(buf.subarray(o[1], o[2]), 'message').toString('hex'),
  };
}

module.exports = { parseCellbaseWitness, parseScript };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cellbase-witness.test.js`
Expected: PASS, 4/4

- [ ] **Step 5: Add to the always-run suite and commit**

Add `test/cellbase-witness.test.js` to the `test` script in `package.json`, after `test/block-hash-regression.test.js`.

```bash
npm test
git add src/wallet/cellbase-witness.js test/cellbase-witness.test.js package.json
git commit -m "wallet: CellbaseWitness molecule parser — chain-derived miner lock per block"
```

---

## Task 2: Treasury schema migration

**Files:**
- Create: `db/migrations/003-treasury.sql`
- Test: `test/treasury-schema.test.js`

**Interfaces:**
- Consumes: `createDb` from `src/accounting/db.js`, `destructiveDbUrl` from `test/tools/test-db.js`
- Produces: tables `treasury_receipts`, `treasury_snapshots`, `wallet_config`; `payout_batches` gains `HELD` state support via `released_by` / `released_at` columns

- [ ] **Step 1: Write the failing test**

```javascript
// test/treasury-schema.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

test('treasury schema', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('treasury_receipts exists with a unique block_id', async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'treasury_receipts' ORDER BY column_name`);
    const cols = rows.map(r => r.column_name);
    for (const c of ['block_id', 'block_height', 'payout_block_height', 'payout_tx_hash',
                     'output_index', 'lock_args', 'amount_shannons', 'mature_at_epoch',
                     'confirmed_at', 'voided_at']) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });

  await t.test('a block cannot have two receipts', async () => {
    await db.query('TRUNCATE treasury_receipts CASCADE');
    const blk = (await db.query(
      `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
       VALUES ('e', gen_random_uuid(), 'j', '0x1', 100, 'NODE_ACCEPTED') RETURNING id`)).rows[0].id;
    const ins = `INSERT INTO treasury_receipts
      (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
       lock_args, amount_shannons, mature_at_epoch)
      VALUES ($1, 100, 111, $2, 0, '0xaa', 1, 5)`;
    await db.query(ins, [blk, '0x' + '11'.repeat(32)]);
    await assert.rejects(
      () => db.query(ins, [blk, '0x' + '22'.repeat(32)]),
      /duplicate key|unique/i,
      'one block, one receipt — a second must be rejected by the database');
  });

  await t.test('the same output cannot be claimed twice', async () => {
    await db.query('TRUNCATE treasury_receipts CASCADE');
    const mk = async () => (await db.query(
      `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
       VALUES ('e', gen_random_uuid(), 'j', '0x' || substr(md5(random()::text),1,8), 100, 'NODE_ACCEPTED')
       RETURNING id`)).rows[0].id;
    const tx = '0x' + '33'.repeat(32);
    await db.query(`INSERT INTO treasury_receipts
      (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
       lock_args, amount_shannons, mature_at_epoch) VALUES ($1,100,111,$2,0,'0xaa',1,5)`,
      [await mk(), tx]);
    await assert.rejects(
      () => db.query(`INSERT INTO treasury_receipts
        (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
         lock_args, amount_shannons, mature_at_epoch) VALUES ($1,100,111,$2,0,'0xaa',1,5)`,
        [await mk(), tx]),
      /duplicate key|unique/i,
      'two blocks must not both claim the same cellbase output');
  });

  await t.test('wallet_config holds exactly one row', async () => {
    await db.query('TRUNCATE wallet_config');
    await db.query(`INSERT INTO wallet_config (id, cold_address) VALUES (1, 'ckb1abc')`);
    await assert.rejects(
      () => db.query(`INSERT INTO wallet_config (id, cold_address) VALUES (2, 'ckb1def')`),
      /check|constraint/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --test-force-exit test/treasury-schema.test.js`
Expected: FAIL — `relation "treasury_receipts" does not exist`

- [ ] **Step 3: Write the migration**

```sql
-- db/migrations/003-treasury.sql — treasury income reconciliation.
--
-- A CKB cellbase in block N pays the miner of block N-11. Recording what the
-- pool ACTUALLY received (rather than reading its own block's cellbase, which
-- pays a stranger) is what makes solvency checkable.
BEGIN;

CREATE TABLE IF NOT EXISTS treasury_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id             uuid NOT NULL UNIQUE REFERENCES blocks(id),
  block_height         bigint NOT NULL,
  payout_block_height  bigint NOT NULL,
  payout_tx_hash       text   NOT NULL,
  output_index         integer NOT NULL,
  lock_args            text   NOT NULL,
  amount_shannons      numeric(39,0) NOT NULL CHECK (amount_shannons >= 0),
  mature_at_epoch      bigint NOT NULL,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  voided_at            timestamptz,
  UNIQUE (payout_tx_hash, output_index)
);
CREATE INDEX IF NOT EXISTS treasury_receipts_height_idx ON treasury_receipts(block_height);
CREATE INDEX IF NOT EXISTS treasury_receipts_conf_idx
  ON treasury_receipts(confirmed_at) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS treasury_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at            timestamptz NOT NULL DEFAULT now(),
  lock_args           text NOT NULL,
  total_shannons      numeric(39,0) NOT NULL,
  spendable_shannons  numeric(39,0) NOT NULL,
  cell_count          integer NOT NULL,
  owed_shannons       numeric(39,0) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS treasury_snapshots_taken_idx ON treasury_snapshots(taken_at);

-- single-row: the cold sweep address, trusted on first use (Plan 2 uses it)
CREATE TABLE IF NOT EXISTS wallet_config (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cold_address  text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  approved_by   text,
  approved_at   timestamptz
);

ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_by text;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_at timestamptz;

COMMIT;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 --test-force-exit test/treasury-schema.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

Add `test/treasury-schema.test.js` to the `test:db` script in `package.json`.

```bash
npm run test:db
git add db/migrations/003-treasury.sql test/treasury-schema.test.js package.json
git commit -m "wallet: treasury schema — receipts, snapshots, cold-address record"
```

---

## Task 3: Receipt matching (pure) with recorded mainnet fixtures

**Files:**
- Create: `src/wallet/reconciler.js`
- Create: `test/fixtures/treasury-receipts-mainnet.json`
- Create: `test/reconciler.test.js`
- Create: `test/tools/capture-receipt-fixtures.js`

**Interfaces:**
- Consumes: `parseCellbaseWitness` (Task 1), `parseEpoch` from `src/mining/ckb-header.js`
- Produces: `REWARD_DELAY_BLOCKS = 11`, `CELLBASE_MATURITY_EPOCHS = 4`, and
  `matchReceipt({ blockHeight, cellbaseWitness, payoutBlock }) -> null | { lockArgs, payoutBlockHeight, payoutTxHash, outputIndex, amountShannons, matureAtEpoch }` where `amountShannons` is a decimal string.

- [ ] **Step 1: Create the fixture file**

```json
{
  "note": "Real mainnet H/H+11 pairs for blocks this pool won. Each block's own cellbase witness names the lock that earned it; the payment arrives 11 blocks later. Block 20160918 is the important one: accounting recorded 829.5442776900 CKB from its own cellbase, while the pool actually received 675.06476541 CKB.",
  "source": "CKB mainnet, read from the pool's trusted node",
  "rewardDelayBlocks": 11,
  "cellbaseMaturityEpochs": 4,
  "cases": [
    {
      "blockHeight": 20152836,
      "expectedLockArgs": "0x5ea0977c3cab6898817c9860fe70d26acf559f76",
      "payoutBlockHeight": 20152847,
      "payoutTxHash": "0x14467a88bd4bc242aa09179b7b09d103672b6a0e608087383dd2b9bbd9c686b2",
      "outputIndex": 0,
      "amountShannons": "80247072037",
      "payoutBlockEpoch": "0x4e8024c003994",
      "matureAtEpoch": 14744,
      "accountingRecordedShannons": "80245035867"
    },
    {
      "blockHeight": 20153038,
      "expectedLockArgs": "0x5ea0977c3cab6898817c9860fe70d26acf559f76",
      "payoutBlockHeight": 20153049,
      "payoutTxHash": "0x1e9ec99f234f085d91d27935de9eafd548fa987df629abc870f362e0fcfd20f9",
      "outputIndex": 0,
      "amountShannons": "80244725756",
      "payoutBlockEpoch": "0x4e80316003994",
      "matureAtEpoch": 14744,
      "accountingRecordedShannons": "80244726168"
    },
    {
      "blockHeight": 20160918,
      "expectedLockArgs": "0x5ea0977c3cab6898817c9860fe70d26acf559f76",
      "payoutBlockHeight": 20160929,
      "payoutTxHash": "0xb59f2292b05d0736ab819a3be90b24bf6400d3ef9e5253f8c0ad0b9415c63ecb",
      "outputIndex": 0,
      "amountShannons": "67506476541",
      "payoutBlockEpoch": "0x5d5000f00399a",
      "matureAtEpoch": 14750,
      "accountingRecordedShannons": "82954427769"
    }
  ]
}
```

The `cellbaseWitness` and full `payoutBlock` bodies are large, so the fixture
stores identifiers and the capture script (Step 2) fetches and appends the raw
block bodies into `cases[].cellbaseWitness` and `cases[].payoutBlock` on first
run. Commit the fixture **with** those fields populated so the test needs no
network.

- [ ] **Step 2: Write the capture script**

```javascript
// test/tools/capture-receipt-fixtures.js
'use strict';
/**
 * Refresh test/fixtures/treasury-receipts-mainnet.json from a trusted node.
 *
 *   POOL_NODE_RPC=http://<host>:8114 node test/tools/capture-receipt-fixtures.js
 *
 * Run this to add new cases (notably the first block mined after a
 * block_assembler change, which is the case most worth pinning). The test
 * itself never touches the network.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRpcClient } = require('../../src/edge/rpc.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'treasury-receipts-mainnet.json');
const url = process.env.POOL_NODE_RPC || 'http://127.0.0.1:8114';
const client = createRpcClient({
  host: url.replace(/^https?:\/\//, '').split(':')[0],
  port: parseInt(url.split(':').pop(), 10),
});

(async () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const c of fx.cases) {
    const mined = await client.rpc('get_block_by_number', ['0x' + c.blockHeight.toString(16)]);
    const payout = await client.rpc('get_block_by_number', ['0x' + c.payoutBlockHeight.toString(16)]);
    c.cellbaseWitness = mined.transactions[0].witnesses[0];
    c.payoutBlock = {
      header: { number: payout.header.number, epoch: payout.header.epoch, hash: payout.header.hash },
      transactions: [{ hash: payout.transactions[0].hash, outputs: payout.transactions[0].outputs }],
    };
    console.log(`captured ${c.blockHeight} -> ${c.payoutBlockHeight}`);
  }
  fs.writeFileSync(FIXTURE, JSON.stringify(fx, null, 1) + '\n');
  console.log('wrote', FIXTURE);
})().catch(e => { console.error(e); process.exit(1); });
```

Run it once against the node to populate the fixture:
`POOL_NODE_RPC=http://192.168.68.105:8114 node test/tools/capture-receipt-fixtures.js`

- [ ] **Step 3: Write the failing test**

```javascript
// test/reconciler.test.js
'use strict';
/**
 * reconciler.test.js — income attribution against recorded mainnet blocks.
 *
 * The bug this pins: accounting read reward_shannons from the pool's OWN
 * cellbase, which in CKB pays the miner of N-11. For block 20160918 that read
 * 829.54 CKB against an actual 675.06 — a 154.48 CKB over-record that would
 * have become a real overpayment once a payout worker existed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { matchReceipt, REWARD_DELAY_BLOCKS, CELLBASE_MATURITY_EPOCHS } =
  require('../src/wallet/reconciler.js');

const FX = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'treasury-receipts-mainnet.json'), 'utf8'));

test('constants match CKB consensus', () => {
  assert.strictEqual(REWARD_DELAY_BLOCKS, 11);
  assert.strictEqual(CELLBASE_MATURITY_EPOCHS, 4);
});

for (const c of FX.cases) {
  test(`block ${c.blockHeight}: attributes the H+11 payment correctly`, () => {
    const r = matchReceipt({
      blockHeight: c.blockHeight,
      cellbaseWitness: c.cellbaseWitness,
      payoutBlock: c.payoutBlock,
    });
    assert.ok(r, 'must find a receipt');
    assert.strictEqual(r.lockArgs, c.expectedLockArgs);
    assert.strictEqual(r.payoutBlockHeight, c.payoutBlockHeight);
    assert.strictEqual(r.payoutTxHash, c.payoutTxHash);
    assert.strictEqual(r.outputIndex, c.outputIndex);
    assert.strictEqual(r.amountShannons, c.amountShannons);
    assert.strictEqual(r.matureAtEpoch, c.matureAtEpoch);
  });
}

test('the recorded reward differs from the block\'s own cellbase — that was the bug', () => {
  const bad = FX.cases.find(c => c.blockHeight === 20160918);
  assert.notStrictEqual(bad.amountShannons, bad.accountingRecordedShannons);
  const delta = BigInt(bad.accountingRecordedShannons) - BigInt(bad.amountShannons);
  assert.ok(delta > 15000000000n, `over-record should exceed 150 CKB, got ${delta}`);
});

test('refuses a payout block at the wrong height rather than guessing', () => {
  const c = FX.cases[0];
  const wrong = JSON.parse(JSON.stringify(c.payoutBlock));
  wrong.header.number = '0x' + (c.payoutBlockHeight + 1).toString(16);
  assert.throws(() => matchReceipt({
    blockHeight: c.blockHeight, cellbaseWitness: c.cellbaseWitness, payoutBlock: wrong,
  }), /height/i);
});

test('returns null when no output pays our lock', () => {
  const c = FX.cases[0];
  const other = JSON.parse(JSON.stringify(c.payoutBlock));
  for (const o of other.transactions[0].outputs) o.lock.args = '0x' + 'ee'.repeat(20);
  assert.strictEqual(matchReceipt({
    blockHeight: c.blockHeight, cellbaseWitness: c.cellbaseWitness, payoutBlock: other,
  }), null);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/reconciler.test.js`
Expected: FAIL — `Cannot find module '../src/wallet/reconciler.js'`

- [ ] **Step 5: Write minimal implementation**

```javascript
// src/wallet/reconciler.js
'use strict';
/**
 * reconciler.js — what did the pool actually earn?
 *
 * A CKB cellbase in block N pays the miner of block N-11. Reading our own
 * block's cellbase therefore reports a STRANGER's reward, which is how
 * accounting over-recorded block 20160918 by 154.48 CKB on 2026-08-15.
 *
 * The correct source is block H+11's cellbase output whose lock matches the
 * lock recorded in block H's OWN cellbase witness. Reading the lock from the
 * witness rather than from configuration is what makes a block_assembler
 * change (2026-08-15) harmless to historical attribution.
 */

const { parseCellbaseWitness } = require('./cellbase-witness.js');
const { parseEpoch } = require('../mining/ckb-header.js');

/** CKB pays a block's reward in the cellbase 11 blocks later. */
const REWARD_DELAY_BLOCKS = 11;
/** A cellbase output is unspendable for this many epochs. */
const CELLBASE_MATURITY_EPOCHS = 4;

function sameLock(a, b) {
  return a.code_hash === b.code_hash && a.hash_type === b.hash_type && a.args === b.args;
}

/**
 * @param {object} p
 * @param {number} p.blockHeight       height of the block we mined (H)
 * @param {string} p.cellbaseWitness   block H's cellbase witness hex
 * @param {object} p.payoutBlock       block H+11 ({header:{number,epoch}, transactions:[cellbase]})
 * @returns {null|{lockArgs:string, payoutBlockHeight:number, payoutTxHash:string,
 *                 outputIndex:number, amountShannons:string, matureAtEpoch:number}}
 */
function matchReceipt({ blockHeight, cellbaseWitness, payoutBlock }) {
  const { lock } = parseCellbaseWitness(cellbaseWitness);
  const expected = blockHeight + REWARD_DELAY_BLOCKS;
  const actual = parseInt(payoutBlock.header.number, 16);
  if (actual !== expected) {
    throw new Error(`payout block height ${actual} != expected ${expected} for block ${blockHeight}`);
  }

  const cellbase = payoutBlock.transactions[0];
  if (!cellbase) throw new Error(`payout block ${actual} has no cellbase`);

  const matches = [];
  cellbase.outputs.forEach((out, index) => {
    if (out.lock && sameLock(out.lock, lock)) matches.push({ index, capacity: BigInt(out.capacity) });
  });
  // absence of a matching output is a real answer (we did not earn it), not an error
  if (matches.length === 0) return null;

  const total = matches.reduce((acc, m) => acc + m.capacity, 0n);
  return {
    lockArgs: lock.args,
    payoutBlockHeight: actual,
    payoutTxHash: cellbase.hash,
    // if a cellbase ever pays our lock in several outputs, the amount is their
    // sum and the index records the first — the UNIQUE(tx,index) key still holds
    outputIndex: matches[0].index,
    amountShannons: total.toString(),
    matureAtEpoch: parseEpoch(payoutBlock.header.epoch).number + CELLBASE_MATURITY_EPOCHS,
  };
}

module.exports = { matchReceipt, REWARD_DELAY_BLOCKS, CELLBASE_MATURITY_EPOCHS };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/reconciler.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

Add `test/reconciler.test.js` to the `test` script in `package.json`.

```bash
npm test
git add src/wallet/reconciler.js test/reconciler.test.js \
        test/fixtures/treasury-receipts-mainnet.json test/tools/capture-receipt-fixtures.js package.json
git commit -m "wallet: receipt matching pinned to recorded mainnet H/H+11 pairs"
```

---

## Task 4: Receipt persistence, confirmation and reorg voiding

**Files:**
- Modify: `src/wallet/reconciler.js` (append `createReconciler`)
- Test: `test/reconciler-db.test.js`

**Interfaces:**
- Consumes: `matchReceipt` (Task 3), `createRpcClient` from `src/edge/rpc.js`
- Produces: `createReconciler({ db, rpcClient, confirmations = 20, logger }) -> { tick(), reconcileBlock(blockRow, tipHeight) }`. Confirmation is not a separate entry point: `reconcileBlock` confirms a receipt in the same pass that re-examines it, once the payout block is `confirmations` deep. (Corrected 2026-08-15 — this line previously advertised a `confirmPending(tipHeight)` that the task's own code never returned and no caller ever used.)

- [ ] **Step 1: Write the failing test**

```javascript
// test/reconciler-db.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { createReconciler } = require('../src/wallet/reconciler.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const FX = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'treasury-receipts-mainnet.json'), 'utf8'));
const CASE = FX.cases[0];

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

/**
 * Serves the fixture's mined block and its payout block. `state.tipHeight` and
 * `state.payout` are mutable so a test can deepen the chain or swap the payout
 * block for a reorged one. `state.payout = null` models a node that has not
 * indexed that height.
 */
function makeNode({ tipHeight, minedWitness = CASE.cellbaseWitness, payout = CASE.payoutBlock }) {
  const state = { tipHeight, payout };
  return {
    state,
    async rpc(method, params) {
      if (method === 'get_tip_header') {
        return { number: '0x' + state.tipHeight.toString(16), epoch: '0x4e8024c003994' };
      }
      if (method === 'get_block_by_number') {
        const h = parseInt(params[0], 16);
        if (h === CASE.blockHeight) {
          return { header: { number: params[0] }, transactions: [{ witnesses: [minedWitness] }] };
        }
        if (h === CASE.payoutBlockHeight) return state.payout;
        return null;
      }
      throw new Error('unexpected rpc ' + method);
    },
  };
}

async function seedBlock(db, height) {
  return (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state)
     VALUES ('au-test', gen_random_uuid(), 'j1', '0x1', $1, 'CANONICAL_IMMATURE') RETURNING id`,
    [height])).rows[0].id;
}

test('receipt persistence', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  const quiet = { log: () => {} };

  await t.test('records a receipt with the real amount', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 });
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();
    const r = (await db.query('SELECT * FROM treasury_receipts WHERE block_id = $1', [id])).rows[0];
    assert.ok(r, 'receipt written');
    assert.strictEqual(r.amount_shannons, CASE.amountShannons);
    assert.strictEqual(r.lock_args, CASE.expectedLockArgs);
    assert.ok(r.confirmed_at, 'deep enough to confirm');
  });

  await t.test('does not confirm while the payout block is too shallow', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 2 });   // < confirmations
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();
    const r = (await db.query('SELECT * FROM treasury_receipts WHERE block_id = $1', [id])).rows[0];
    assert.ok(r, 'receipt seen');
    assert.strictEqual(r.confirmed_at, null, 'must not confirm at shallow depth');
  });

  await t.test('is idempotent — a second tick writes no duplicate', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 });
    const rec = createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet });
    await rec.tick();
    await rec.tick();
    const { rows } = await db.query('SELECT count(*)::int c FROM treasury_receipts');
    assert.strictEqual(rows[0].c, 1);
  });

  await t.test('voids a receipt whose payout block was reorged away', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    const id = await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 2 });
    const rec = createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet });
    await rec.tick();                       // seen, unconfirmed
    const replaced = JSON.parse(JSON.stringify(CASE.payoutBlock));
    replaced.transactions[0].hash = '0x' + 'cc'.repeat(32);   // different tx at that height
    node.state.payout = replaced;
    node.state.tipHeight = CASE.payoutBlockHeight + 50;
    await rec.tick();
    const r = (await db.query('SELECT * FROM treasury_receipts WHERE block_id = $1', [id])).rows[0];
    assert.ok(r.voided_at, 'a reorged receipt must be voided, not confirmed');
    assert.strictEqual(r.confirmed_at, null);
  });

  await t.test('a null block from the node records nothing', async () => {
    await db.query('TRUNCATE treasury_receipts, blocks CASCADE');
    await seedBlock(db, CASE.blockHeight);
    const node = makeNode({ tipHeight: CASE.payoutBlockHeight + 50 });
    node.state.payout = null;
    await createReconciler({ db, rpcClient: node, confirmations: 20, logger: quiet }).tick();
    const { rows } = await db.query('SELECT count(*)::int c FROM treasury_receipts');
    assert.strictEqual(rows[0].c, 0, 'missing evidence is not a zero receipt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --test-force-exit test/reconciler-db.test.js`
Expected: FAIL — `createReconciler is not a function`

- [ ] **Step 3: Append the implementation to `src/wallet/reconciler.js`**

```javascript
/**
 * Persistent reconciliation over the `blocks` table.
 *
 * Rules, all of them lessons from 2026-08-14/15:
 *  - a null or failed lookup records nothing (missing evidence is not a zero);
 *  - a receipt confirms only once its payout block is `confirmations` deep;
 *  - if the payout block's cellbase tx hash changes before confirmation, the
 *    receipt is voided rather than confirmed.
 */
function createReconciler({ db, rpcClient, confirmations = 20, logger = console }) {
  const hx = n => '0x' + BigInt(n).toString(16);

  async function blockAt(height) {
    try { return await rpcClient.rpc('get_block_by_number', [hx(height)]); }
    catch (e) { logger.log('WALLET', `get_block_by_number(${height}) failed: ${e.message}`); return null; }
  }

  async function reconcileBlock(row, tipHeight) {
    const height = parseInt(row.height, 10);
    const payoutHeight = height + REWARD_DELAY_BLOCKS;
    if (payoutHeight > tipHeight) return;                    // not paid yet

    const mined = await blockAt(height);
    const witness = mined?.transactions?.[0]?.witnesses?.[0];
    if (!witness) { logger.log('WALLET', `block ${height}: no cellbase witness yet`); return; }

    const payout = await blockAt(payoutHeight);
    if (!payout?.transactions?.[0]) {
      logger.log('WALLET', `block ${height}: payout block ${payoutHeight} not available`);
      return;
    }

    let receipt;
    try { receipt = matchReceipt({ blockHeight: height, cellbaseWitness: witness, payoutBlock: payout }); }
    catch (e) { logger.log('WALLET', `block ${height}: ${e.message}`); return; }
    if (!receipt) { logger.log('WALLET', `block ${height}: no output pays our lock`); return; }

    const deep = tipHeight - payoutHeight >= confirmations;

    const existing = (await db.query(
      'SELECT id, payout_tx_hash, confirmed_at, voided_at FROM treasury_receipts WHERE block_id = $1',
      [row.id])).rows[0];

    if (!existing) {
      await db.query(
        `INSERT INTO treasury_receipts
           (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
            lock_args, amount_shannons, mature_at_epoch, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() ELSE NULL END)
         ON CONFLICT (block_id) DO NOTHING`,
        [row.id, height, receipt.payoutBlockHeight, receipt.payoutTxHash, receipt.outputIndex,
         receipt.lockArgs, receipt.amountShannons, receipt.matureAtEpoch, deep]);
      logger.log('WALLET', `block ${height}: receipt ${receipt.amountShannons} shannons from ${payoutHeight}${deep ? ' (confirmed)' : ''}`);
      return;
    }

    if (existing.confirmed_at || existing.voided_at) return;   // settled already

    if (existing.payout_tx_hash !== receipt.payoutTxHash) {
      await db.query('UPDATE treasury_receipts SET voided_at = now() WHERE id = $1', [existing.id]);
      logger.log('WALLET', `block ${height}: payout block ${payoutHeight} changed — receipt VOIDED`);
      return;
    }
    if (deep) {
      await db.query('UPDATE treasury_receipts SET confirmed_at = now() WHERE id = $1', [existing.id]);
      logger.log('WALLET', `block ${height}: receipt confirmed`);
    }
  }

  async function tick() {
    const tip = await rpcClient.rpc('get_tip_header', []);
    const tipHeight = parseInt(tip?.number, 16);
    if (!Number.isFinite(tipHeight)) {
      logger.log('WALLET', `unusable tip header (number=${tip?.number}) — skipping tick`);
      return;
    }
    const { rows } = await db.query(
      `SELECT b.id, b.height FROM blocks b
         LEFT JOIN treasury_receipts r ON r.block_id = b.id
        WHERE b.height IS NOT NULL
          AND b.state IN ('CANONICAL_IMMATURE','MATURE','ALLOCATED','SETTLED_TO_LEDGER')
          AND (r.id IS NULL OR (r.confirmed_at IS NULL AND r.voided_at IS NULL))
        ORDER BY b.height`);
    for (const row of rows) await reconcileBlock(row, tipHeight);
  }

  return { tick, reconcileBlock };
}

module.exports.createReconciler = createReconciler;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 --test-force-exit test/reconciler-db.test.js`
Expected: PASS, 5/5 subtests

- [ ] **Step 5: Commit**

Add `test/reconciler-db.test.js` to the `test:db` script in `package.json`.

```bash
npm run test:db
git add src/wallet/reconciler.js test/reconciler-db.test.js package.json
git commit -m "wallet: persist, confirm and void receipts; missing evidence never records a zero"
```

---

## Task 5: The `pool-wallet` service

**Files:**
- Create: `src/wallet/main.js`
- Create: `deploy/systemd/pool-wallet.service`
- Test: `test/wallet-service.test.js`

**Interfaces:**
- Consumes: `createReconciler` (Task 4), `BUILD_INFO` from `src/common/build-info.js`, `createDb`, `createRpcClient`
- Produces: a service exposing `/health` (JSON) and `/metrics` (Prometheus) on `POOL_WALLET_METRICS_PORT`, default `9102`

- [ ] **Step 1: Write the failing test**

```javascript
// test/wallet-service.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wallet-service.test.js`
Expected: FAIL — `Cannot find module '../src/wallet/main.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
#!/usr/bin/env node
'use strict';
/**
 * main.js — pool-wallet service.
 *
 * Plan 1 scope: reconcile income only. This process holds NO signing key and
 * has no transaction-building path; it cannot move funds. It reads Postgres and
 * the trusted CKB node, and listens on loopback for metrics only.
 *
 *   POOL_DB_URL=... POOL_NODE_RPC=http://127.0.0.1:8114 node src/wallet/main.js
 */

const { createDb } = require('../accounting/db.js');
const { createRpcClient } = require('../edge/rpc.js');
const { createReconciler } = require('./reconciler.js');
const { BUILD_INFO } = require('../common/build-info.js');

const HELP_BUILD = '# HELP pool_build_info commit this process was started from (1 = always)';

function buildMetrics(m) {
  return [
    HELP_BUILD,
    '# TYPE pool_build_info gauge',
    `pool_build_info{commit="${BUILD_INFO.commit || 'unknown'}",started_at="${BUILD_INFO.startedAt}"} 1`,
    `pool_wallet_ticks_total ${m.ticks || 0}`,
    `pool_wallet_receipts_recorded_total ${m.receipts_recorded || 0}`,
    `pool_wallet_receipts_confirmed_total ${m.receipts_confirmed || 0}`,
    `pool_wallet_receipts_voided_total ${m.receipts_voided || 0}`,
    `pool_wallet_rpc_errors_total ${m.rpc_errors || 0}`,
  ].join('\n') + '\n';
}

async function main() {
  const db = createDb(process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest');
  await db.migrate(require('node:path').join(__dirname, '..', '..', 'db', 'migrations'));

  const nodeUrl = process.env.POOL_NODE_RPC || 'http://127.0.0.1:8114';
  const rpcClient = createRpcClient({
    host: nodeUrl.replace(/^https?:\/\//, '').split(':')[0],
    port: parseInt(nodeUrl.split(':').pop() || '8114', 10),
  });

  const metrics = { ticks: 0, receipts_recorded: 0, receipts_confirmed: 0, receipts_voided: 0, rpc_errors: 0 };
  const reconciler = createReconciler({
    db, rpcClient,
    confirmations: parseInt(process.env.POOL_WALLET_CONFIRMATIONS || '20', 10),
    logger: console,
  });

  const port = parseInt(process.env.POOL_WALLET_METRICS_PORT || '9102', 10);
  const server = require('node:http').createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, build: BUILD_INFO, signing: false, ...metrics }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(buildMetrics(metrics));
      return;
    }
    res.writeHead(404); res.end();
  }).listen(port, '127.0.0.1', () => console.log(`[WALLET] metrics on http://127.0.0.1:${port}/metrics`));

  console.log(`[WALLET] started commit=${BUILD_INFO.commitShort} node=${nodeUrl} signing=disabled`);

  const intervalMs = parseInt(process.env.POOL_WALLET_TICK_MS || '300000', 10);
  const timer = setInterval(async () => {
    try { await reconciler.tick(); metrics.ticks++; }
    catch (e) { metrics.rpc_errors++; console.log('WALLET', `tick failed: ${e.message}`); }
  }, intervalMs);

  const shutdown = async () => {
    clearInterval(timer);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await reconciler.tick().catch(e => console.log('WALLET', `initial tick failed: ${e.message}`));
  metrics.ticks++;
}

if (require.main === module) main().catch(e => { console.error('[WALLET] fatal:', e); process.exit(1); });

module.exports = { buildMetrics, HELP_BUILD };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/wallet-service.test.js`
Expected: PASS, 3/3

- [ ] **Step 5: Write the systemd unit**

```ini
# deploy/systemd/pool-wallet.service
[Unit]
Description=CKB Interim Pool — treasury reconciliation (no signing key)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=pool-wallet
Group=pool-wallet
WorkingDirectory=/opt/wyltek-pool
Environment=POOL_DB_URL=postgres://pool:CHANGEME@127.0.0.1:5432/pooltest
Environment=POOL_NODE_RPC=http://127.0.0.1:8114
Environment=POOL_WALLET_TICK_MS=300000
Environment=POOL_WALLET_CONFIRMATIONS=20
Environment=POOL_WALLET_METRICS_PORT=9102
ExecStart=/usr/bin/node src/wallet/main.js
Restart=always
RestartSec=5
MemoryHigh=256M
MemoryMax=512M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryDenyWriteExecute=yes
LimitCORE=0

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 6: Commit**

Add `test/wallet-service.test.js` to the `test` script in `package.json`, and add
`http://127.0.0.1:9102/metrics` to the default `POOL_METRICS_URLS` in
`deploy/check-stale.sh`.

```bash
npm test
git add src/wallet/main.js deploy/systemd/pool-wallet.service test/wallet-service.test.js \
        package.json deploy/check-stale.sh
git commit -m "wallet: pool-wallet service — reconciliation tick, metrics, build stamp, no signing path"
```

---

## Task 6: Switch accounting's reward source to reconciled receipts

**Files:**
- Modify: `src/accounting/block-tracker.js` (remove reward extraction)
- Modify: `src/accounting/allocator.js:76-90` (read from `treasury_receipts`)
- Modify: `test/block-tracker.test.js` (drop reward assertions)
- Test: `test/allocator.test.js` (add gating tests)

**Interfaces:**
- Consumes: `treasury_receipts` rows (Task 4)
- Produces: `allocateMatureBlock` returns `{ allocated: false, reason: 'awaiting-receipt' }` when no confirmed receipt exists

These two files must change together: the tracker stops writing the number the
allocator reads, so a reviewer cannot sensibly approve one without the other.

- [ ] **Step 1: Write the failing test**

```javascript
// append to test/allocator.test.js
test('a block with no confirmed receipt is not allocated', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE treasury_receipts, blocks, share_events, ingested_events, sessions, workers, miners, edge_boots, edges CASCADE');

  const blockId = (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state, template_json)
     VALUES ('e', gen_random_uuid(), 'j', '0x1', 100, 'MATURE', '{"compact_target":"0x191b3f4f"}'::jsonb)
     RETURNING id`)).rows[0].id;

  const r = await allocateMatureBlock(db, { blockId, logger: { log: () => {} } });
  assert.strictEqual(r.allocated, false, 'must not allocate without verified income');
  assert.strictEqual(r.reason, 'awaiting-receipt');
});

test('allocation uses the receipt amount, not the block cellbase', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE treasury_receipts, blocks, share_events, ingested_events, sessions, workers, miners, edge_boots, edges CASCADE');

  // the real 2026-08-15 numbers: block cellbase said 829.54, we received 675.06
  const blockId = (await db.query(
    `INSERT INTO blocks (edge_id, boot_id, job_id, nonce, height, state, reward_shannons, template_json)
     VALUES ('e', gen_random_uuid(), 'j', '0x1', 20160918, 'MATURE', 82954427769,
             '{"compact_target":"0x191b3f4f"}'::jsonb) RETURNING id`)).rows[0].id;
  await db.query(
    `INSERT INTO treasury_receipts
       (block_id, block_height, payout_block_height, payout_tx_hash, output_index,
        lock_args, amount_shannons, mature_at_epoch, confirmed_at)
     VALUES ($1, 20160918, 20160929, $2, 0, '0x5ea0977c3cab6898817c9860fe70d26acf559f76',
             67506476541, 14750, now())`,
    [blockId, '0xb59f2292b05d0736ab819a3be90b24bf6400d3ef9e5253f8c0ad0b9415c63ecb']);

  const reward = await rewardForBlock(db, blockId);
  assert.strictEqual(reward, '67506476541',
    'the pool may only distribute what it actually received');
});
```

Add `const { rewardForBlock } = require('../src/accounting/allocator.js');` to the
imports at the top of `test/allocator.test.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --test-force-exit test/allocator.test.js`
Expected: FAIL — `rewardForBlock is not a function`

- [ ] **Step 3: Modify `src/accounting/allocator.js`**

Add near the top of the module:

```javascript
/**
 * The reward a block actually earned, from the wallet's reconciled receipt.
 *
 * NOT from the block's own cellbase: in CKB that cellbase pays the miner of
 * N-11, so reading it reports a stranger's reward. On 2026-08-15 that
 * over-recorded block 20160918 by 154.48 CKB. `pool-wallet` writes the true
 * figure; allocation waits for it.
 *
 * @returns {Promise<string|null>} shannons as a decimal string, or null if the
 *   income has not been verified yet
 */
async function rewardForBlock(db, blockId) {
  const { rows } = await db.query(
    `SELECT amount_shannons FROM treasury_receipts
      WHERE block_id = $1 AND confirmed_at IS NOT NULL AND voided_at IS NULL`,
    [blockId]);
  return rows[0] ? String(rows[0].amount_shannons) : null;
}
```

Then, inside `allocateMatureBlock`, replace the use of `b.reward_shannons` with:

```javascript
  const rewardShannons = await rewardForBlock(db, blockId);
  if (rewardShannons === null) {
    // income not yet verified on chain — revert the guard and try again later
    await db.query(`UPDATE blocks SET state = 'MATURE' WHERE id = $1`, [blockId]);
    logger.log('ALLOC', `block ${String(blockId).slice(0, 8)} awaiting treasury receipt`);
    return { allocated: false, reason: 'awaiting-receipt' };
  }
```

and pass `rewardShannons` where `b.reward_shannons` was passed to `allocateBlock`.
Export it: `module.exports = { ..., rewardForBlock };`

- [ ] **Step 4: Modify `src/accounting/block-tracker.js`**

In the canonical branch, delete the cellbase summation and the
`reward_shannons` assignment. The `UPDATE` becomes:

```javascript
          await db.query(
            `UPDATE blocks SET state = $1, block_hash = $2,
               block_epoch_json = $3,
               node_accepted_at = COALESCE(node_accepted_at, now()),
               matured_at = CASE WHEN $4 THEN now() ELSE matured_at END,
               orphaned_at = NULL
             WHERE id = $5`,
            [mature ? 'MATURE' : 'CANONICAL_IMMATURE', '0x' + canonicalHash,
             blockEpochHex, mature, b.id],
          );
```

Update the header comment to state that reward extraction now lives in
`src/wallet/reconciler.js` and why. In `test/block-tracker.test.js`, delete the
assertion `assert.strictEqual(row.reward_shannons, reward.toString(), ...)` and
the now-unused `reward` fixture value.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test && npm run test:db`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/accounting/allocator.js src/accounting/block-tracker.js \
        test/allocator.test.js test/block-tracker.test.js
git commit -m "accounting: reward comes from reconciled treasury receipts, not the block's own cellbase

A CKB cellbase pays the miner of N-11, so block-tracker was recording a
stranger's reward — 154.48 CKB over on block 20160918. The tracker's job
narrows to canonicality and maturity; allocation now waits for verified income."
```

---

## Task 7: Treasury balance snapshots

**Files:**
- Create: `src/wallet/treasury.js`
- Modify: `src/wallet/main.js` (snapshot each tick)
- Test: `test/treasury.test.js`

**Interfaces:**
- Consumes: `createRpcClient`, `CELLBASE_MATURITY_EPOCHS` (Task 3)
- Produces: `spendableSplit({ cells, tipEpochNumber }) -> { total, spendable, cellCount }` with `total`/`spendable` as decimal strings; `snapshotLocks(db, rpcClient, indexerUrl)`

- [ ] **Step 1: Write the failing test**

```javascript
// test/treasury.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spendableSplit } = require('../src/wallet/treasury.js');

const cell = (capacity, epochNumber, isCellbase = true) =>
  ({ capacity, blockEpochNumber: epochNumber, isCellbase });

test('cellbase cells are unspendable until 4 epochs after their block', () => {
  const r = spendableSplit({
    cells: [cell('100', 10), cell('200', 14), cell('400', 15)],
    tipEpochNumber: 18,
  });
  // matures at 14 and 18 -> spendable; matures at 19 -> not
  assert.strictEqual(r.total, '700');
  assert.strictEqual(r.spendable, '300');
  assert.strictEqual(r.cellCount, 3);
});

test('non-cellbase cells are spendable immediately', () => {
  const r = spendableSplit({ cells: [cell('500', 18, false)], tipEpochNumber: 18 });
  assert.strictEqual(r.spendable, '500');
});

test('an empty cell set reports zero without pretending it is authoritative', () => {
  const r = spendableSplit({ cells: [], tipEpochNumber: 18 });
  assert.strictEqual(r.total, '0');
  assert.strictEqual(r.spendable, '0');
  assert.strictEqual(r.cellCount, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/treasury.test.js`
Expected: FAIL — `Cannot find module '../src/wallet/treasury.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/wallet/treasury.js
'use strict';
/**
 * treasury.js — what the pool holds, and how much of it can actually be spent.
 *
 * A pool's income is entirely cellbase outputs, which are unspendable for
 * CELLBASE_MATURITY_EPOCHS after the block that created them. Treating total
 * balance as spendable is how a payout builds a transaction the chain rejects,
 * so the split is computed explicitly and never conflated.
 */

const { CELLBASE_MATURITY_EPOCHS } = require('./reconciler.js');

/**
 * @param {object} p
 * @param {Array<{capacity:string, blockEpochNumber:number, isCellbase:boolean}>} p.cells
 * @param {number} p.tipEpochNumber
 * @returns {{total:string, spendable:string, cellCount:number}}
 */
function spendableSplit({ cells, tipEpochNumber }) {
  let total = 0n;
  let spendable = 0n;
  for (const c of cells) {
    const cap = BigInt(c.capacity);
    total += cap;
    const mature = !c.isCellbase ||
      tipEpochNumber >= c.blockEpochNumber + CELLBASE_MATURITY_EPOCHS;
    if (mature) spendable += cap;
  }
  return { total: total.toString(), spendable: spendable.toString(), cellCount: cells.length };
}

module.exports = { spendableSplit };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/treasury.test.js`
Expected: PASS, 3/3

- [ ] **Step 5: Wire snapshots into the tick**

In `src/wallet/main.js`, after `reconciler.tick()` inside the interval callback,
insert a snapshot write for each distinct `lock_args` in `treasury_receipts`:

```javascript
      // observability: one row per lock we have ever mined to, so treasury
      // movement is answerable after the fact rather than reconstructed
      const locks = await db.query(
        `SELECT lock_args, sum(amount_shannons) AS received
           FROM treasury_receipts WHERE voided_at IS NULL AND confirmed_at IS NOT NULL
          GROUP BY lock_args`);
      const owed = (await db.query(
        `SELECT COALESCE(sum(amount_shannons), 0) AS owed FROM ledger_entries
          WHERE account_type = 'miner_confirmed'`)).rows[0].owed;
      for (const l of locks.rows) {
        await db.query(
          `INSERT INTO treasury_snapshots
             (lock_args, total_shannons, spendable_shannons, cell_count, owed_shannons)
           VALUES ($1, $2, 0, 0, $3)`,
          [l.lock_args, l.received, owed]);
      }
```

Plan 1 records received-income totals; live cell enumeration and the real
spendable figure arrive in Plan 2 with the indexer client.

- [ ] **Step 6: Commit**

Add `test/treasury.test.js` to the `test` script in `package.json`.

```bash
npm test
git add src/wallet/treasury.js src/wallet/main.js test/treasury.test.js package.json
git commit -m "wallet: spendable-vs-total split honouring cellbase maturity; per-lock snapshots"
```

---

## Task 8: `poolctl wallet` read-only commands

**Files:**
- Modify: `src/accounting/poolctl.js`
- Test: manual verification against the live database

**Interfaces:**
- Consumes: `treasury_receipts`, `treasury_snapshots`
- Produces: `poolctl wallet status`, `poolctl wallet receipts [height]`

- [ ] **Step 1: Add the command**

In the `switch (cmd)` block add `case 'wallet': return await cmdWallet(db, rest);`
and add to the usage banner. Then:

```javascript
async function cmdWallet(db, [action, arg]) {
  if (action === 'status') {
    const r = (await db.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE confirmed_at IS NOT NULL AND voided_at IS NULL)::int confirmed,
              count(*) FILTER (WHERE confirmed_at IS NULL AND voided_at IS NULL)::int pending,
              count(*) FILTER (WHERE voided_at IS NOT NULL)::int voided,
              COALESCE(sum(amount_shannons) FILTER (WHERE confirmed_at IS NOT NULL AND voided_at IS NULL), 0) received
         FROM treasury_receipts`)).rows[0];
    const owed = (await db.query(
      `SELECT COALESCE(sum(amount_shannons), 0) owed FROM ledger_entries
        WHERE account_type = 'miner_confirmed'`)).rows[0].owed;
    const unreconciled = (await db.query(
      `SELECT count(*)::int c FROM blocks b
         LEFT JOIN treasury_receipts r ON r.block_id = b.id
        WHERE b.height IS NOT NULL AND b.state IN ('MATURE','ALLOCATED','SETTLED_TO_LEDGER')
          AND r.id IS NULL`)).rows[0].c;
    console.log(JSON.stringify({
      receipts: r, owed_shannons: String(owed),
      blocks_awaiting_reconciliation: unreconciled,
      solvent: BigInt(r.received) >= BigInt(owed),
    }, null, 2));
    return;
  }
  if (action === 'receipts') {
    const { rows } = await db.query(
      `SELECT block_height, payout_block_height, lock_args, amount_shannons,
              payout_tx_hash, confirmed_at, voided_at
         FROM treasury_receipts
        WHERE ($1::bigint IS NULL OR block_height = $1)
        ORDER BY block_height DESC LIMIT 50`, [arg ? Number(arg) : null]);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.error('usage: poolctl wallet <status|receipts [height]>');
  process.exit(2);
}
```

- [ ] **Step 2: Verify against the live database**

```bash
POOL_DB_URL=postgres://pool:pooltest@127.0.0.1:5433/pooltest node src/accounting/poolctl.js wallet status
```

Expected: valid JSON. Before the wallet service has run, `receipts.total` is 0
and `blocks_awaiting_reconciliation` is non-zero; `solvent` is `false` because
the ledger records 1,588.85 CKB owed against zero reconciled income. That is the
correct reading of the current state, and it resolves when the slate is wiped.

- [ ] **Step 3: Commit**

```bash
node --check src/accounting/poolctl.js
git add src/accounting/poolctl.js
git commit -m "poolctl: wallet status and receipts (read-only)"
```

---

## Task 9: Run the service against the live chain

**Files:** none — this is a verification task

- [ ] **Step 1: Start the service against the live node, unarmed by construction**

```bash
cd /home/phill/wyltek-pool
POOL_DB_URL=postgres://pool:pooltest@127.0.0.1:5433/pooltest \
POOL_NODE_RPC=http://192.168.68.105:8114 \
POOL_WALLET_TICK_MS=60000 \
node src/wallet/main.js
```

- [ ] **Step 2: Confirm receipts appear for the blocks already mined**

```bash
POOL_DB_URL=postgres://pool:pooltest@127.0.0.1:5433/pooltest node src/accounting/poolctl.js wallet receipts
```

Expected: a receipt per canonical block. Verify block 20160918 records
`67506476541` and **not** `82954427769`. That single number is the whole point
of this plan.

- [ ] **Step 3: Confirm the staleness check covers the new service**

```bash
bash deploy/check-stale.sh
```

Expected: both `:9101` and `:9102` reported, both matching tree HEAD.

- [ ] **Step 4: Commit nothing; report findings**

If any receipt disagrees with the chain, stop and investigate before Plan 2.
Plan 2 grants this system the ability to spend, and it will spend against these
numbers.

---

## Out of scope (Plan 2)

Signing key handling, cell collection with maturity filtering and oldest-first
ordering, payout batching under caps, the `HELD` approval path, cold sweep with
trust-on-first-use, admin console treasury views, and the dev-chain end-to-end
payment test. The slate wipe is specified separately (spec §13).
