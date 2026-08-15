# pool-wallet Plan 2: Capped Autonomous Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the pool pay its miners unattended, within bounds the operator sets, without ever spending more than it has actually received.

**Architecture:** The `pool-wallet` service gains a signing key and, with it, the ability to spend. Everything dangerous is gated: the treasury lock is *derived* from the key rather than configured, cells are selected only when mature and oldest-first, a batch may only pay addresses that are owed money, totals are capped per batch and per rolling day, anything over cap parks as `HELD` for a human, and no transaction is broadcast at all unless `POOL_WALLET_ARMED=1`. Surplus above a float sweeps to a cold address that is trusted on first use.

**Tech Stack:** Node.js 22 (CommonJS, no build step), `node:test` + `node:assert`, PostgreSQL via `pg`, `@noble/curves` for secp256k1 (already a dependency), CKB JSON-RPC over plain `http`.

**Spec:** `docs/superpowers/specs/2026-08-15-pool-wallet-design.md` (§6 payout execution, §7 sweep, §8 key handling, §9 failure modes, §11 configuration)

**Predecessor:** `docs/superpowers/plans/2026-08-15-pool-wallet-reconciliation.md` — merged. The wallet already reconciles income into `treasury_receipts` and holds no key. This plan gives it one.

## Global Constraints

- Node.js 22, CommonJS (`require`), `'use strict'` at the top of every file — match existing `src/` style
- **No new runtime dependencies.** `@noble/curves` (secp256k1), `pg`, `ws`, `ajv`, `nats` are the whole list
- CKB reward delay is **11 blocks**, cellbase maturity is **4 epochs** — use `REWARD_DELAY_BLOCKS` / `CELLBASE_MATURITY_EPOCHS` from `src/wallet/reconciler.js`, never inline literals
- Money is `BigInt` or decimal strings end-to-end. **Never `Number` for shannons**
- **The key is never logged, never written to the database, never included in an error message.** The derived *address* may be logged and should be
- **Broadcasting requires `POOL_WALLET_ARMED=1`.** Unarmed, the service does everything except move money
- Cells are selected **mature only, oldest-first** — a pool's income is entirely cellbase outputs, unspendable for 4 epochs
- Caps are **derived by query, never kept in a counter** — a counter is state that can diverge from the truth it claims to describe
- **Never sweep funds owed to miners**, even above the float
- Destructive DB tests use `destructiveDbUrl()` from `test/tools/test-db.js`, which refuses any database not named disposable. Never hardcode a URL; never point one at `pooltest`
- Several tasks append to `package.json`'s `test` / `test:db` scripts — **append, never rewrite or reorder**
- `test/wallet-service.test.js` scans every `.js` in `src/wallet/` for signing symbols. **That test must be updated deliberately in Task 6, not worked around** — it is the guard that made Plan 1 trustworthy, and Task 6 is the moment its premise legitimately changes

---

## What Plan 1 left you

Read these before starting; the plan assumes them.

| Module | Exports you will consume |
|---|---|
| `src/wallet/treasury.js` | `spendableSplit({cells, tipEpoch})` → `{total, spendable, cellCount}` (decimal strings). `cells` are `{capacity, blockEpoch:{number,index,length}, isCellbase}`; `tipEpoch` is `{number,index,length}`. Fraction-aware. **Currently has no production caller — Task 2 gives it one.** Also `snapshotTreasuryLocks(db)`, `epochAtLeast(a,b)` |
| `src/wallet/reconciler.js` | `REWARD_DELAY_BLOCKS` (11), `CELLBASE_MATURITY_EPOCHS` (4), `matchReceipt(...)`, `createReconciler({db, rpcClient, confirmations, logger})` → `{tick, reconcileBlock}` |
| `src/wallet/main.js` | `buildMetrics(m, counts)`, `readReceiptCounts(db)`, `HELP_BUILD` |
| `src/accounting/ledger.js` | `ACCOUNTS` (`CONFIRMED`, `PENDING_PAYOUT`, `PAID`, `POOL_FEE`, `TX_FEE`, `ROUNDING`, `ADJUSTMENT`, `IMMATURE`), `postEntry`, `balanceFor`, `auditableBlocks`, `verifyBlockConservation` |
| `src/payout/ckb-tx-builder.js` | `lockOf(pubkeyCompressedHex)` → `{code_hash: SIGHASH_ALL_TYPE_HASH, hash_type:'type', args: '0x'+blake160(pubkey)}`, `buildAndSendBatchPayout`, `collectCellsFromIndexer`, `resolveSecpDeps`, `estimateSize` |
| `src/payout/payout-worker.js` | `createPayoutWorker({db, txBuilder, minimumPayoutShannons, maxItemsPerBatch, logger})` → `{runOnce, eligibleMiners, createBatch, processBatch, confirmBatch, recoverPendingBatches}` |
| Database | `treasury_receipts` (confirmed/voided, partial unique indexes over un-voided rows), `treasury_snapshots` (`spendable_shannons`/`cell_count` currently NULL — Task 2 makes them real), `wallet_config` (single row: `cold_address`, `recorded_at`, `approved_by`, `approved_at`), `payout_batches` (+ `released_by`, `released_at`) |

**Two known defects in the inherited tx builder, both fixed by this plan:** `collectCellsFromIndexer` uses `order: 'desc'` (newest first — the worst possible choice when income is entirely cellbase) and applies no maturity filter. Task 2 replaces the collection path; Task 6 makes the builder use it.

**One inherited design point:** `treasury_receipts` stores only `lock_args`, not a full script. That is fine — the treasury lock is *derived from the key* (spec §3), never read back from receipts. Task 1 additionally uses the receipts' `lock_args` as a cross-check that the key matches the income.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/wallet/keystore.js` (new) | Load the key, derive the treasury lock and address, fail-to-start assertions. The only module that touches key bytes |
| `src/wallet/cells.js` (new) | Collect the treasury lock's live cells; classify cellbase and maturity; select oldest-first |
| `src/wallet/caps.js` (new) | Cap arithmetic: per-batch, per-miner, rolling 24h — all derived |
| `src/wallet/sweep.js` (new) | Sweep amount, cold-address validation, trust-on-first-use |
| `src/wallet/payout-worker.js` (moved from `src/payout/`) | Batch state machine, now including `HELD` |
| `src/wallet/tx-builder.js` (moved from `src/payout/ckb-tx-builder.js`) | RFC 0022 sighash_all build/sign/broadcast, fed by `cells.js` |
| `src/wallet/main.js` (modify) | Wire the payout tick, arming, new metrics |
| `db/migrations/006-wallet-payouts.sql` (new) | `HELD` support bookkeeping and the sweep ledger reference |
| `src/accounting/poolctl.js` (modify) | `wallet doctor`, `wallet approve`, `wallet sweep --dry-run` |
| `src/api/admin-server.js` (modify) | Treasury views + the release action |
| `deploy/systemd/pool-wallet.service` (modify) | Key path, arming, hardening |
| `test/wallet-service.test.js` (modify) | The signing-symbol guard, narrowed in Task 6 to the modules that legitimately may not sign |

---

## Task 1: Keystore — load the key, derive the lock, refuse to start when wrong

**Files:**
- Create: `src/wallet/keystore.js`
- Test: `test/keystore.test.js`

**Interfaces:**
- Consumes: `lockOf` from `src/payout/ckb-tx-builder.js`; `secp256k1` from `@noble/curves/secp256k1`
- Produces: `loadKeystore({keyPath, expectedAddress = null, network = 'ckb'})` → `{ privateKey: Buffer, lock: {code_hash, hash_type, args}, address: string }`, throwing on any failure; `lockToAddress(lock, hrp)` → bech32m full address string; `deriveLock(privateKey)` → lock

- [ ] **Step 1: Write the failing test**

```javascript
// test/keystore.test.js
'use strict';
/**
 * keystore.test.js — the only module that touches key bytes.
 *
 * Two properties matter more than the rest: the key never appears in any
 * output, and a WRONG key fails loudly. A wrong key does not error on its
 * own — it silently operates a different wallet, finds no cells, reports a
 * zero balance and pays nobody while looking perfectly healthy.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadKeystore, deriveLock, lockToAddress } = require('../src/wallet/keystore.js');

// a throwaway key, generated for this test and used nowhere else
const KEY = '0101010101010101010101010101010101010101010101010101010101010101';

function keyFile(contents = KEY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-'));
  const p = path.join(dir, 'payout.privkey');
  fs.writeFileSync(p, contents, { mode: 0o600 });
  return p;
}

test('derives a stable secp256k1_blake160 lock from a key', () => {
  const lock = deriveLock(Buffer.from(KEY, 'hex'));
  assert.strictEqual(lock.code_hash,
    '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8');
  assert.strictEqual(lock.hash_type, 'type');
  assert.match(lock.args, /^0x[0-9a-f]{40}$/);
  // stable across calls — the lock is a pure function of the key
  assert.strictEqual(deriveLock(Buffer.from(KEY, 'hex')).args, lock.args);
});

test('loads a key file and reports its address', () => {
  const ks = loadKeystore({ keyPath: keyFile() });
  assert.match(ks.address, /^ckb1/);
  assert.strictEqual(ks.lock.args, deriveLock(Buffer.from(KEY, 'hex')).args);
  assert.ok(Buffer.isBuffer(ks.privateKey));
});

test('the address round-trips to the same lock', () => {
  const lock = deriveLock(Buffer.from(KEY, 'hex'));
  const addr = lockToAddress(lock, 'ckb');
  assert.strictEqual(lockToAddress(deriveLock(Buffer.from(KEY, 'hex')), 'ckb'), addr);
});

test('refuses to start when the key file is missing', () => {
  assert.throws(() => loadKeystore({ keyPath: '/nonexistent/payout.privkey' }),
    /key file/i);
});

test('refuses a key file that is not 32 bytes of hex', () => {
  assert.throws(() => loadKeystore({ keyPath: keyFile('nothex') }), /32 bytes|hex/i);
  assert.throws(() => loadKeystore({ keyPath: keyFile('aabb') }), /32 bytes/i);
});

test('refuses to start when the derived address is not the expected one', () => {
  // the assertion that catches a wrong key file, which otherwise fails silent
  assert.throws(
    () => loadKeystore({ keyPath: keyFile(), expectedAddress: 'ckb1qsomethingelse' }),
    /expected address/i);
});

test('accepts a matching expected address', () => {
  const ks = loadKeystore({ keyPath: keyFile() });
  const again = loadKeystore({ keyPath: keyFile(), expectedAddress: ks.address });
  assert.strictEqual(again.address, ks.address);
});

test('no error message ever contains the key', () => {
  const p = keyFile();
  for (const expected of ['ckb1qwrong']) {
    try {
      loadKeystore({ keyPath: p, expectedAddress: expected });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(!e.message.includes(KEY), 'key leaked into an error message');
      assert.ok(!e.stack.includes(KEY), 'key leaked into a stack trace');
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keystore.test.js`
Expected: FAIL — `Cannot find module '../src/wallet/keystore.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/wallet/keystore.js
'use strict';
/**
 * keystore.js — the only module in the wallet that touches key bytes.
 *
 * The treasury lock is DERIVED from the key and never configured (spec §3).
 * Configuration can drift; a derived lock cannot point at the wrong wallet
 * without the key itself being wrong.
 *
 * `expectedAddress` exists because a wrong key file does not error. It
 * silently operates a DIFFERENT wallet: no cells found, zero balance
 * reported, nobody paid, everything apparently healthy. Asserting the
 * derived address turns that silent failure into a refusal to start.
 *
 * The key is never logged, never persisted, never included in an error
 * message. The derived ADDRESS is safe to log and should be, so an operator
 * can see at a glance which wallet is armed.
 */

const fs = require('node:fs');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { lockOf } = require('../payout/ckb-tx-builder.js');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convert8to5(bytes) {
  let acc = 0, bits = 0;
  const out = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}

const HASH_TYPE_BYTE = { data: 0, type: 1, data1: 2, data2: 4 };

/**
 * CKB full address (bech32m): payload = 0x00 | code_hash | hash_type | args.
 * @returns {string}
 */
function lockToAddress(lock, hrp = 'ckb') {
  const ht = HASH_TYPE_BYTE[lock.hash_type];
  if (ht === undefined) throw new Error(`unknown hash_type ${lock.hash_type}`);
  const payload = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(lock.code_hash.replace(/^0x/, ''), 'hex'),
    Buffer.from([ht]),
    Buffer.from(lock.args.replace(/^0x/, ''), 'hex'),
  ]);
  const data = convert8to5(payload);
  const chk = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  const sum = [];
  for (let i = 0; i < 6; i++) sum.push((chk >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...sum].map(i => CHARSET[i]).join('');
}

/** @param {Buffer} privateKey @returns {{code_hash:string, hash_type:string, args:string}} */
function deriveLock(privateKey) {
  const pub = secp256k1.getPublicKey(privateKey, true);   // compressed
  return lockOf(Buffer.from(pub).toString('hex'));
}

/**
 * @param {object} p
 * @param {string} p.keyPath            path to a 32-byte hex private key
 * @param {string|null} [p.expectedAddress]  fail-to-start assertion
 * @param {string} [p.network]          'ckb' (mainnet) or 'ckt' (test)
 * @returns {{privateKey: Buffer, lock: object, address: string}}
 */
function loadKeystore({ keyPath, expectedAddress = null, network = 'ckb' }) {
  let raw;
  try { raw = fs.readFileSync(keyPath, 'utf8').trim(); }
  catch (e) { throw new Error(`key file unreadable at ${keyPath}: ${e.code || e.message}`); }

  const hex = raw.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    // deliberately does not echo the contents
    throw new Error(`key file at ${keyPath} must contain exactly 32 bytes of hex`);
  }

  const privateKey = Buffer.from(hex, 'hex');
  const lock = deriveLock(privateKey);
  const address = lockToAddress(lock, network);

  if (expectedAddress && address !== expectedAddress) {
    throw new Error(
      `key at ${keyPath} derives ${address} but expected address is ${expectedAddress} — ` +
      `refusing to start rather than operate a different wallet`);
  }

  return { privateKey, lock, address };
}

module.exports = { loadKeystore, deriveLock, lockToAddress };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keystore.test.js`
Expected: PASS, 8/8

- [ ] **Step 5: Commit**

Append `test/keystore.test.js` to the `test` script in `package.json`, and `src/wallet/keystore.js` to the `lint` script.

```bash
npm test
git add src/wallet/keystore.js test/keystore.test.js package.json
git commit -m "wallet: keystore — lock derived from the key, wrong key refuses to start"
```

---

## Task 2: Cell collection — mature only, oldest-first, and a real spendable balance

**Files:**
- Create: `src/wallet/cells.js`
- Modify: `src/wallet/treasury.js` (snapshot writes real spendable/cell_count)
- Test: `test/cells.test.js`

**Interfaces:**
- Consumes: `spendableSplit`, `epochAtLeast` from `src/wallet/treasury.js`; `CELLBASE_MATURITY_EPOCHS` from `src/wallet/reconciler.js`
- Produces: `parseEpochFields(epochHex)` → `{number, index, length}`; `classifyCells(rawCells)` → cells shaped for `spendableSplit`; `selectOldestFirst(cells, targetShannons)` → `{selected, total}`; `collectLiveCells({indexerUrl, lock, rpc})` → raw cell array

- [ ] **Step 1: Write the failing test**

```javascript
// test/cells.test.js
'use strict';
/**
 * cells.test.js — a mining pool's income is ENTIRELY cellbase outputs, and a
 * cellbase output is unspendable for 4 epochs. Two defects in the inherited
 * builder made that dangerous: it collected newest-first (exactly the
 * immature ones) and applied no maturity filter at all. A transaction built
 * from those cells is rejected by the node.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseEpochFields, classifyCells, selectOldestFirst } =
  require('../src/wallet/cells.js');

// CKB EpochNumberWithFraction: number bits 0-23, index 24-39, length 40-55
test('parses the packed epoch fields', () => {
  assert.deepStrictEqual(parseEpochFields('0x4e8024c003994'),
    { number: 14740, index: 588, length: 1256 });
  assert.deepStrictEqual(parseEpochFields('0x5d5000f00399a'),
    { number: 14746, index: 15, length: 1493 });
});

const raw = (capacity, blockNumber, epochHex, isCellbase) => ({
  output: { capacity },
  block_number: '0x' + blockNumber.toString(16),
  tx_index: isCellbase ? '0x0' : '0x1',
  out_point: { tx_hash: '0x' + 'aa'.repeat(32), index: '0x0' },
  block_epoch: epochHex,
});

test('classifies a cellbase by its position, not a guess', () => {
  const [cb, tx] = classifyCells([
    raw('0x1', 100, '0x4e8024c003994', true),
    raw('0x2', 100, '0x4e8024c003994', false),
  ]);
  assert.strictEqual(cb.isCellbase, true, 'tx_index 0 is the cellbase');
  assert.strictEqual(tx.isCellbase, false);
  assert.deepStrictEqual(cb.blockEpoch, { number: 14740, index: 588, length: 1256 });
});

test('selects oldest-first, not newest-first', () => {
  const cells = classifyCells([
    raw('0x64', 300, '0x4e8024c003994', true),   // 100, newest
    raw('0x64', 100, '0x4e8024c003994', true),   // 100, oldest
    raw('0x64', 200, '0x4e8024c003994', true),   // 100
  ]);
  const { selected, total } = selectOldestFirst(cells, 150n);
  assert.strictEqual(total, '200');
  assert.deepStrictEqual(selected.map(c => c.blockNumber), [100, 200],
    'must take the two oldest, not the newest — newest cellbases are the immature ones');
});

test('selecting more than is available returns everything it has', () => {
  const cells = classifyCells([raw('0x64', 100, '0x4e8024c003994', true)]);
  const { selected, total } = selectOldestFirst(cells, 10_000n);
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(total, '100');
});

test('an empty cell set selects nothing rather than throwing', () => {
  const { selected, total } = selectOldestFirst([], 100n);
  assert.deepStrictEqual(selected, []);
  assert.strictEqual(total, '0');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cells.test.js`
Expected: FAIL — `Cannot find module '../src/wallet/cells.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/wallet/cells.js
'use strict';
/**
 * cells.js — what the treasury holds on chain, and which of it can be spent.
 *
 * A mining pool's income is entirely cellbase outputs, and a cellbase output
 * is unspendable until CELLBASE_MATURITY_EPOCHS after its block. The builder
 * this replaces collected cells `order: 'desc'` — newest first — with no
 * maturity filter, which selects precisely the cells the chain will reject.
 *
 * Selection is oldest-first: correct for maturity, and it keeps the UTXO set
 * from fragmenting into an ever-growing tail of small change cells.
 */

const { spendableSplit } = require('./treasury.js');

/** CKB packs an epoch as number(0-23) | index(24-39) | length(40-55). */
function parseEpochFields(epochHex) {
  const v = BigInt(epochHex);
  return {
    number: Number(v & 0xffffffn),
    index: Number((v >> 24n) & 0xffffn),
    length: Number((v >> 40n) & 0xffffn),
  };
}

/**
 * Shape indexer cells for `spendableSplit` and for selection.
 * A cell is a cellbase exactly when it is the first transaction of its block.
 */
function classifyCells(rawCells) {
  return rawCells.map(c => ({
    capacity: BigInt(c.output.capacity).toString(),
    blockNumber: Number(BigInt(c.block_number)),
    blockEpoch: parseEpochFields(c.block_epoch),
    isCellbase: BigInt(c.tx_index) === 0n,
    outPoint: c.out_point,
  }));
}

/**
 * Take cells oldest-first until `targetShannons` is covered.
 * @returns {{selected: Array, total: string}} total as a decimal string
 */
function selectOldestFirst(cells, targetShannons) {
  const ordered = [...cells].sort((a, b) => a.blockNumber - b.blockNumber);
  const selected = [];
  let total = 0n;
  for (const c of ordered) {
    if (total >= targetShannons) break;
    selected.push(c);
    total += BigInt(c.capacity);
  }
  return { selected, total: total.toString() };
}

/**
 * All live cells at a lock, via the ckb-indexer `get_cells` cursor.
 * An exhausted scan returns last_cursor "0x"; never persist or re-send that
 * value — `after: "0x"` returns nothing forever, even once new cells exist.
 */
async function collectLiveCells({ indexerUrl, lock, rpc }) {
  const cells = [];
  let after = null;
  for (let page = 0; page < 200; page++) {
    const params = {
      script: { code_hash: lock.code_hash, hash_type: lock.hash_type, args: lock.args },
      script_type: 'lock',
      filter: null,
      with_data: false,
      order: 'asc',           // oldest first at the source too
      limit: '0x64',
    };
    if (after) params.after = after;
    const res = await rpc(indexerUrl, 'get_cells', [params]);
    const objects = res?.objects || [];
    cells.push(...objects);
    if (objects.length === 0) break;              // break BEFORE reading the cursor
    if (!res.last_cursor || res.last_cursor === '0x') break;
    after = res.last_cursor;
  }
  return cells;
}

/** Convenience: classified cells plus the spendable/total split at a tip epoch. */
function treasuryView({ rawCells, tipEpochHex }) {
  const cells = classifyCells(rawCells);
  const split = spendableSplit({ cells, tipEpoch: parseEpochFields(tipEpochHex) });
  return { cells, ...split };
}

module.exports = {
  parseEpochFields, classifyCells, selectOldestFirst, collectLiveCells, treasuryView,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cells.test.js`
Expected: PASS, 5/5

- [ ] **Step 5: Make the snapshot report real numbers**

`src/wallet/treasury.js`'s `snapshotTreasuryLocks` currently writes NULL for `spendable_shannons` and `cell_count`, because Plan 1 had no indexer client. It has one now. Give the function optional `{indexerUrl, rpc, tipEpochHex, lock}`; when supplied, compute the split via `treasuryView` and write real values. When not supplied, keep writing NULL — never write `0` for a figure you did not measure.

Add a DB test in `test/treasury-db.test.js` asserting both paths: measured values written when a lock and indexer are given, NULL when they are not.

- [ ] **Step 6: Commit**

Append `test/cells.test.js` to the `test` script and `src/wallet/cells.js` to `lint`.

```bash
npm test && npm run test:db
git add src/wallet/cells.js src/wallet/treasury.js test/cells.test.js test/treasury-db.test.js package.json
git commit -m "wallet: mature-only oldest-first cell selection; snapshots report real spendable"
```

---

## Task 3: Caps — derived, never counted

**Files:**
- Create: `src/wallet/caps.js`
- Test: `test/caps.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `capVerdict({batchTotal, dailySpent, perMiner, limits})` → `{allowed: boolean, reason: string|null}`; `dailySpentShannons(db)` → decimal string

- [ ] **Step 1: Write the failing test**

```javascript
// test/caps.test.js
'use strict';
/**
 * caps.test.js — capped autonomy: the wallet may pay unattended, but only
 * within bounds. A breach parks the batch for a human rather than shrinking
 * it, because auto-splitting an over-cap batch defeats the cap entirely —
 * whatever can trigger one payout can trigger ten.
 */
const test = require('node:test');
const assert = require('node:assert');
const { capVerdict } = require('../src/wallet/caps.js');

const LIMITS = { maxBatchShannons: '200000000000', maxDailyShannons: '1000000000000' };

test('a batch within every cap is allowed', () => {
  const v = capVerdict({
    batchTotal: '100000000000', dailySpent: '0',
    perMiner: [{ minerId: 'm1', amount: '100000000000', owed: '100000000000' }],
    limits: LIMITS,
  });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.reason, null);
});

test('a batch over the per-batch cap is refused, not trimmed', () => {
  const v = capVerdict({
    batchTotal: '200000000001', dailySpent: '0',
    perMiner: [{ minerId: 'm1', amount: '200000000001', owed: '200000000001' }],
    limits: LIMITS,
  });
  assert.strictEqual(v.allowed, false);
  assert.match(v.reason, /per-batch/i);
});

test('the rolling daily cap counts what was already spent', () => {
  const v = capVerdict({
    batchTotal: '100000000000', dailySpent: '950000000000',
    perMiner: [{ minerId: 'm1', amount: '100000000000', owed: '100000000000' }],
    limits: LIMITS,
  });
  assert.strictEqual(v.allowed, false);
  assert.match(v.reason, /daily/i);
});

test('exactly at a cap is allowed — the cap is a ceiling, not an exclusive bound', () => {
  assert.strictEqual(capVerdict({
    batchTotal: '200000000000', dailySpent: '800000000000',
    perMiner: [{ minerId: 'm1', amount: '200000000000', owed: '200000000000' }],
    limits: LIMITS,
  }).allowed, true);
});

test('paying a miner more than they are owed is refused', () => {
  const v = capVerdict({
    batchTotal: '100', dailySpent: '0',
    perMiner: [{ minerId: 'm1', amount: '100', owed: '99' }],
    limits: LIMITS,
  });
  assert.strictEqual(v.allowed, false);
  assert.match(v.reason, /owed/i);
});

test('caps are compared as BigInt, not as numbers', () => {
  // 9007199254740993 exceeds Number.MAX_SAFE_INTEGER; as a float it rounds
  // down to ...992 and would compare equal to the cap
  const v = capVerdict({
    batchTotal: '9007199254740993', dailySpent: '0',
    perMiner: [{ minerId: 'm1', amount: '9007199254740993', owed: '9007199254740993' }],
    limits: { maxBatchShannons: '9007199254740992', maxDailyShannons: '99999999999999999' },
  });
  assert.strictEqual(v.allowed, false, 'one shannon over the cap must be refused');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/caps.test.js`
Expected: FAIL — `Cannot find module '../src/wallet/caps.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/wallet/caps.js
'use strict';
/**
 * caps.js — the bounds that make unattended payment safe.
 *
 * An over-cap batch is HELD for a human, never auto-split into cap-sized
 * pieces: splitting defeats the cap, since whatever can trigger one payout
 * can trigger ten. The cap binds on the total.
 *
 * The daily figure is DERIVED by summing broadcast batches in the window,
 * never kept in a counter. A counter is state that can diverge from the
 * truth it claims to describe — which is exactly how a stale figure caused
 * a real incident in this project on 2026-08-14.
 */

/**
 * @param {object} p
 * @param {string} p.batchTotal   decimal shannons
 * @param {string} p.dailySpent   decimal shannons broadcast in the last 24h
 * @param {Array<{minerId:string, amount:string, owed:string}>} p.perMiner
 * @param {{maxBatchShannons:string, maxDailyShannons:string}} p.limits
 * @returns {{allowed:boolean, reason:string|null}}
 */
function capVerdict({ batchTotal, dailySpent, perMiner, limits }) {
  const total = BigInt(batchTotal);
  const maxBatch = BigInt(limits.maxBatchShannons);
  const maxDaily = BigInt(limits.maxDailyShannons);

  for (const m of perMiner) {
    if (BigInt(m.amount) > BigInt(m.owed)) {
      return {
        allowed: false,
        reason: `miner ${m.minerId} would be paid ${m.amount} but is owed ${m.owed}`,
      };
    }
  }
  if (total > maxBatch) {
    return { allowed: false, reason: `per-batch cap exceeded: ${batchTotal} > ${limits.maxBatchShannons}` };
  }
  if (BigInt(dailySpent) + total > maxDaily) {
    return {
      allowed: false,
      reason: `rolling 24h cap exceeded: ${dailySpent} already spent + ${batchTotal} > ${limits.maxDailyShannons}`,
    };
  }
  return { allowed: true, reason: null };
}

/** Broadcast value in the last 24 hours, derived from the batches themselves. */
async function dailySpentShannons(db) {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(i.amount_shannons), 0) AS spent
       FROM payout_batches b
       JOIN payout_items i ON i.batch_id = b.id
      WHERE b.broadcast_at IS NOT NULL
        AND b.broadcast_at > now() - interval '24 hours'`);
  return String(rows[0].spent);
}

module.exports = { capVerdict, dailySpentShannons };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/caps.test.js`
Expected: PASS, 6/6

- [ ] **Step 5: Commit**

Append `test/caps.test.js` to the `test` script and `src/wallet/caps.js` to `lint`.

```bash
npm test
git add src/wallet/caps.js test/caps.test.js package.json
git commit -m "wallet: cap arithmetic — derived daily window, refuse rather than split"
```

---

## Task 4: Move the payout subsystem into the wallet, add the HELD state

**Files:**
- Move: `src/payout/payout-worker.js` → `src/wallet/payout-worker.js`
- Move: `src/payout/ckb-tx-builder.js` → `src/wallet/tx-builder.js`
- Move: `src/payout/ckb-in-process.js` → `src/wallet/tx-builder-inprocess.js`
- Move: `src/payout/tx-builder.js` → `src/wallet/tx-builder-stub.js` (dry-run + ckb-cli builders)
- Delete: `src/payout/main.js` (replaced by the wallet service tick)
- Create: `db/migrations/006-wallet-payouts.sql`
- Modify: `test/payout.test.js`, `test/payout-tx.test.js` (import paths)
- Modify: `src/wallet/keystore.js` (import path for `lockOf`)

**Interfaces:**
- Consumes: everything the old modules exported, at new paths
- Produces: the same exports at `src/wallet/*`; `payout_batches.state` gains `HELD`

- [ ] **Step 1: Move the files and fix every import**

Use `git mv` so history follows. Then update every `require` that pointed into `src/payout/` — grep for it and fix each, including `src/wallet/keystore.js` from Task 1 and the two payout test files. `src/payout/` should be empty afterwards; remove the directory.

- [ ] **Step 2: Run the existing suites to prove the move changed nothing**

Run: `npm test && npm run test:db`
Expected: the same pass counts as before the move. A move that changes behaviour is not a move.

- [ ] **Step 3: Write the failing test for HELD**

```javascript
// append to test/payout.test.js
test('a batch can be HELD and later released', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE payout_items, payout_batches CASCADE');

  const id = '01a00000-0000-7000-8000-000000000001';
  await db.query(`INSERT INTO payout_batches (id, state) VALUES ($1, 'HELD')`, [id]);

  const held = (await db.query(`SELECT state, released_by, released_at FROM payout_batches WHERE id = $1`, [id])).rows[0];
  assert.strictEqual(held.state, 'HELD');
  assert.strictEqual(held.released_by, null, 'a held batch is not released until someone releases it');

  await db.query(
    `UPDATE payout_batches SET state = 'RESERVED', released_by = $2, released_at = now()
      WHERE id = $1 AND state = 'HELD'`, [id, 'operator@console']);

  const released = (await db.query(`SELECT state, released_by, released_at FROM payout_batches WHERE id = $1`, [id])).rows[0];
  assert.strictEqual(released.state, 'RESERVED');
  assert.strictEqual(released.released_by, 'operator@console');
  assert.ok(released.released_at, 'release must be stamped — this is the audit trail');
});
```

- [ ] **Step 4: Run it and see it fail**

Run: `node --test --test-concurrency=1 --test-force-exit test/payout.test.js`
Expected: FAIL — the `HELD` insert is rejected, or `released_by` is missing, depending on the current schema.

- [ ] **Step 5: Write the migration**

```sql
-- db/migrations/006-wallet-payouts.sql — payout states for capped autonomy.
--
-- HELD is the parking state for a batch that breached a cap. It is NOT an
-- error: the batch is correct, it simply exceeds what the wallet may pay
-- without a human. Releasing it stamps who did so and when.
BEGIN;

-- released_by / released_at were added by 003; ensure they exist for any
-- database that skipped it
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_by text;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_at timestamptz;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS held_reason text;

CREATE INDEX IF NOT EXISTS payout_batches_held_idx
  ON payout_batches(created_at) WHERE state = 'HELD';

COMMIT;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test --test-concurrency=1 --test-force-exit test/payout.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
npm test && npm run test:db
git add -A src/wallet src/payout db/migrations/006-wallet-payouts.sql test package.json
git commit -m "wallet: absorb the payout subsystem; HELD state for capped autonomy"
```

---

## Task 5: Batch construction under caps

**Files:**
- Modify: `src/wallet/payout-worker.js`
- Test: `test/payout-caps.test.js`

**Interfaces:**
- Consumes: `capVerdict`, `dailySpentShannons` (Task 3)
- Produces: `createPayoutWorker({..., limits})`; `createBatch` returns `{batchId, items, state}` where `state` is `'RESERVED'` or `'HELD'`

- [ ] **Step 1: Write the failing test**

```javascript
// test/payout-caps.test.js
'use strict';
/**
 * payout-caps.test.js — a batch that breaches a cap must PARK, not shrink.
 * The whole point of the cap is that a compromised or buggy caller cannot
 * drain the wallet by asking repeatedly.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { createPayoutWorker } = require('../src/wallet/payout-worker.js');
const { postEntry, ACCOUNTS } = require('../src/accounting/ledger.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

const dryBuilder = { async buildBatchTransfer() { throw new Error('must not build while HELD'); } };

async function seedMiner(db, address, owedShannons) {
  const id = (await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ($1, 'ckb')
     ON CONFLICT (payout_address) DO UPDATE SET last_seen_at = now() RETURNING id`,
    [address])).rows[0].id;
  await postEntry(db, {
    accountType: ACCOUNTS.CONFIRMED, minerId: id, amountShannons: owedShannons,
    referenceType: 'test', referenceId: 'seed',
    idempotencyKey: `test:seed:${address}:${owedShannons}`,
  });
  return id;
}

test('cap enforcement at batch construction', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  const quiet = { log: () => {} };
  const LIMITS = { maxBatchShannons: '200000000000', maxDailyShannons: '1000000000000' };

  await t.test('a batch within the caps is RESERVED', async () => {
    await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
    await seedMiner(db, 'ckb1qtest0001', '150000000000');   // 1500 CKB
    const w = createPayoutWorker({ db, txBuilder: dryBuilder, limits: LIMITS, logger: quiet });
    const batch = await w.createBatch(await w.eligibleMiners());
    assert.strictEqual(batch.state, 'RESERVED');
  });

  await t.test('a batch over the per-batch cap is HELD with a reason, and reserves nothing', async () => {
    await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
    await seedMiner(db, 'ckb1qtest0002', '250000000000');   // 2500 CKB, over the 2000 cap
    const w = createPayoutWorker({ db, txBuilder: dryBuilder, limits: LIMITS, logger: quiet });
    const batch = await w.createBatch(await w.eligibleMiners());

    assert.strictEqual(batch.state, 'HELD');
    const row = (await db.query(`SELECT state, held_reason FROM payout_batches WHERE id = $1`, [batch.batchId])).rows[0];
    assert.strictEqual(row.state, 'HELD');
    assert.match(row.held_reason, /per-batch/i, 'the operator must be told WHY it parked');

    // a held batch must not move money in the ledger
    const pending = (await db.query(
      `SELECT COALESCE(sum(amount_shannons),0) s FROM ledger_entries WHERE account_type = $1`,
      [ACCOUNTS.PENDING_PAYOUT])).rows[0].s;
    assert.strictEqual(String(pending), '0', 'HELD must not reserve — nothing is owed to a batch nobody approved');
  });

  await t.test('a released batch proceeds on the next run', async () => {
    await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
    await seedMiner(db, 'ckb1qtest0003', '250000000000');
    const w = createPayoutWorker({ db, txBuilder: dryBuilder, limits: LIMITS, logger: quiet });
    const batch = await w.createBatch(await w.eligibleMiners());
    assert.strictEqual(batch.state, 'HELD');

    await db.query(
      `UPDATE payout_batches SET state='RESERVED', released_by='op', released_at=now() WHERE id=$1`,
      [batch.batchId]);
    const after = (await db.query(`SELECT state FROM payout_batches WHERE id = $1`, [batch.batchId])).rows[0];
    assert.strictEqual(after.state, 'RESERVED');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test --test-concurrency=1 --test-force-exit test/payout-caps.test.js`
Expected: FAIL — `createBatch` returns no `state`, and `limits` is not a parameter.

- [ ] **Step 3: Implement**

In `createPayoutWorker`, accept `limits` and, inside `createBatch`, before any `payout_items` insert or ledger posting:

1. **check solvency first** (see below),
2. compute the intended per-miner amounts and their owed balances,
3. call `dailySpentShannons(db)`,
4. call `capVerdict(...)`.

**The insolvency gate (spec §9).** Before anything else, compare what the ledger says is owed against what the wallet has actually reconciled. If owed exceeds reconciled income, the pool believes it owes more than it ever received — that is not a cap breach to park, it is a stop:

```javascript
  /**
   * Refuse to pay anything at all when the ledger claims more is owed than
   * the wallet has reconciled as received. A cap breach parks one batch; this
   * is different in kind — it means the books disagree with the chain, and
   * paying anyone out of a treasury that cannot cover its liabilities is how
   * a pool becomes insolvent quietly.
   */
  async function solvencyGate() {
    const { rows } = await db.query(
      `SELECT
         (SELECT COALESCE(sum(amount_shannons), 0) FROM treasury_receipts
           WHERE confirmed_at IS NOT NULL AND voided_at IS NULL) AS received,
         (SELECT COALESCE(sum(amount_shannons), 0) FROM ledger_entries
           WHERE account_type = ANY($1)) AS owed`,
      [[ACCOUNTS.CONFIRMED, ACCOUNTS.PENDING_PAYOUT]]);
    const received = BigInt(rows[0].received);
    const owed = BigInt(rows[0].owed);
    if (owed > received) {
      return { ok: false, reason: `owed ${owed} exceeds reconciled income ${received}` };
    }
    return { ok: true, reason: null };
  }
```

On `ok: false`, log it at incident level, increment an insolvency counter for the alert, and return without creating a batch at all. Do **not** park it as `HELD` — `HELD` means "correct but needs approval", and this is not correct.

Add a fourth subtest to the test file above proving it: seed a miner owed 1000 CKB with **no** `treasury_receipts` rows, and assert `createBatch` creates no batch row and posts no ledger entries.

On `allowed: false`, insert the batch row with `state = 'HELD'` and `held_reason = verdict.reason`, insert **no** items and post **no** ledger entries, and return `{batchId, items: 0, state: 'HELD'}`. On `allowed: true`, proceed exactly as today and return `state: 'RESERVED'`.

The ordering matters: reserving first and un-reserving on a cap breach would put ledger entries behind a decision no human has made yet.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-concurrency=1 --test-force-exit test/payout-caps.test.js`
Expected: PASS, 3/3 subtests

- [ ] **Step 5: Commit**

Append `test/payout-caps.test.js` to `test:db`.

```bash
npm run test:db
git add src/wallet/payout-worker.js test/payout-caps.test.js package.json
git commit -m "wallet: batches breaching a cap park as HELD and reserve nothing"
```

---

## Task 6: Arming, signing, and broadcast

**Files:**
- Modify: `src/wallet/tx-builder.js` (feed it `cells.js`)
- Modify: `src/wallet/main.js` (keystore, arming, payout tick)
- Modify: `test/wallet-service.test.js` (the signing-symbol guard changes premise here)
- Test: `test/wallet-arming.test.js`

**Interfaces:**
- Consumes: `loadKeystore` (Task 1), `collectLiveCells`/`classifyCells`/`selectOldestFirst` (Task 2), `createPayoutWorker` (Task 5)
- Produces: `main.js` exports gain `isArmed(env)`; the builder selects only mature cells

- [ ] **Step 1: Update the signing-symbol guard deliberately**

Plan 1 asserted that **no** file in `src/wallet/` contains `privateKey`, `send_transaction`, `sign(` or `POOL_WALLET_KEY`. That premise legitimately ends here — this task is where the wallet gains the ability to spend.

Do not delete the guard. Narrow it: `keystore.js`, `tx-builder.js`, `tx-builder-inprocess.js` and `main.js` are the modules permitted to reference key or signing symbols; every other file in `src/wallet/` must still be clean. Write it as an explicit allowlist so adding a fifth signing file is a deliberate edit someone must justify:

```javascript
const MAY_SIGN = new Set([
  'keystore.js', 'tx-builder.js', 'tx-builder-inprocess.js', 'main.js',
]);

test('only the designated modules may reference signing or key material', () => {
  const dir = path.dirname(require.resolve('../src/wallet/main.js'));
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    if (MAY_SIGN.has(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const sym of ['privateKey', 'send_transaction', 'POOL_WALLET_KEY']) {
      if (src.includes(sym)) offenders.push(`${f}: ${sym}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a module outside the signing allowlist referenced key material');
});
```

- [ ] **Step 2: Write the failing arming test**

```javascript
// test/wallet-arming.test.js
'use strict';
/**
 * wallet-arming.test.js — a fresh deployment must not be able to move money.
 * After 2026-08-14 the default failure mode should be "did nothing", not
 * "did something at 3am".
 */
const test = require('node:test');
const assert = require('node:assert');
const { isArmed } = require('../src/wallet/main.js');

test('unset is not armed', () => {
  assert.strictEqual(isArmed({}), false);
});

test('only the exact string "1" arms the wallet', () => {
  assert.strictEqual(isArmed({ POOL_WALLET_ARMED: '1' }), true);
  for (const v of ['0', '', 'true', 'yes', 'TRUE', ' 1', '1 ', 'armed']) {
    assert.strictEqual(isArmed({ POOL_WALLET_ARMED: v }), false,
      `"${v}" must not arm the wallet — only "1" does`);
  }
});

test('dry-run overrides arming', () => {
  assert.strictEqual(isArmed({ POOL_WALLET_ARMED: '1', POOL_WALLET_DRY_RUN: '1' }), false);
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `node --test test/wallet-arming.test.js`
Expected: FAIL — `isArmed is not a function`

- [ ] **Step 4: Implement arming and wire the payout tick**

In `src/wallet/main.js`:

```javascript
/**
 * Broadcasting requires POOL_WALLET_ARMED=1 exactly. A fresh deploy
 * reconciles, snapshots and builds batches but moves no money until an
 * operator arms it deliberately. Dry-run always wins.
 */
function isArmed(env) {
  if (env.POOL_WALLET_DRY_RUN === '1') return false;
  return env.POOL_WALLET_ARMED === '1';
}
```

Load the keystore at startup when `POOL_WALLET_KEY` is set, log the derived **address** (never the key), and refuse to start if the derived address does not match `POOL_WALLET_EXPECTED_ADDRESS` when that is set. With no key configured, run exactly as Plan 1 did: reconcile and snapshot, no payout tick.

Add the payout pass to the tick, in its own try/catch with its own log tag and its own error counter, so a payout failure is never mistaken for a reconciliation failure.

- [ ] **Step 5: Feed the builder mature cells**

Replace `collectCellsFromIndexer`'s use inside `src/wallet/tx-builder.js` with `collectLiveCells` + `classifyCells` + a maturity filter + `selectOldestFirst`. Delete the `order: 'desc'` path. Cellbase cells that are not yet mature must never enter a transaction.

- [ ] **Step 6: Harden the systemd unit (spec §8)**

`deploy/systemd/pool-wallet.service` currently describes a service with no key. It now has one. Add the key environment and the hardening the spec requires:

```ini
Environment=POOL_WALLET_KEY=/etc/wyltek-pool/payout.privkey
Environment=POOL_WALLET_EXPECTED_ADDRESS=
Environment=POOL_WALLET_COLD_ADDRESS=
Environment=POOL_WALLET_ARMED=0
Environment=POOL_WALLET_FLOAT_SHANNONS=500000000000
Environment=POOL_WALLET_MAX_BATCH_SHANNONS=200000000000
Environment=POOL_WALLET_MAX_DAILY_SHANNONS=1000000000000
Environment=POOL_INDEXER_URL=http://127.0.0.1:8114
```

Keep `User=pool-wallet` (deliberately not the `pool` user that runs the NATS-facing accounting service, so the key file is unreadable to it), and confirm the unit still carries `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`, `MemoryDenyWriteExecute=yes`, `LimitCORE=0`.

Ship `POOL_WALLET_ARMED=0` in the unit. An operator arms deliberately, after `poolctl wallet doctor` passes; a unit that ships armed makes the safe default a matter of someone remembering.

Update `docs/interim-pool/RUNBOOK.md`: the key file's provisioning and `0600` ownership by `pool-wallet`, running `poolctl wallet doctor` before arming, and how to release a `HELD` batch.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run test:db`
Expected: PASS, including the narrowed signing guard.

- [ ] **Step 8: Commit**

Append `test/wallet-arming.test.js` to `test`.

```bash
git add src/wallet/main.js src/wallet/tx-builder.js deploy/systemd/pool-wallet.service \
        docs/interim-pool/RUNBOOK.md test/wallet-arming.test.js test/wallet-service.test.js package.json
git commit -m "wallet: arming gate, keystore wiring, mature-cell selection, hardened unit"
```

---

## Task 7: Confirmation and crash recovery

**Files:**
- Modify: `src/wallet/payout-worker.js`
- Test: `test/payout-recovery.test.js`

**Interfaces:**
- Consumes: `confirmBatch`, `recoverPendingBatches` (existing)
- Produces: recovery that reconciles by `tx_hash` against chain before creating any new batch

- [ ] **Step 1: Write the failing test**

```javascript
// test/payout-recovery.test.js
'use strict';
/**
 * payout-recovery.test.js — the dangerous case is a crash between
 * broadcasting and recording it: the money has moved but the database does
 * not know. Creating a second batch then pays twice, and nothing on chain
 * will undo it. Recovery must reconcile by tx_hash against chain BEFORE any
 * new batch is created.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { createPayoutWorker } = require('../src/wallet/payout-worker.js');
const { ACCOUNTS } = require('../src/accounting/ledger.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const TX = '0x' + 'bb'.repeat(32);

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

/** A node that either knows the tx or does not. */
function makeNode({ committed }) {
  return {
    async rpc(method, params) {
      if (method === 'get_transaction') {
        if (!committed) return null;
        return { transaction: { hash: params[0] }, tx_status: { status: 'committed' } };
      }
      throw new Error('unexpected rpc ' + method);
    },
  };
}

const refuseToBuild = {
  async buildBatchTransfer() {
    throw new Error('must not build a new batch while one is unreconciled');
  },
};

async function seedBroadcastBatch(db, txHash) {
  const id = (await db.query(
    `INSERT INTO payout_batches (id, state, broadcast_at, tx_hash)
     VALUES (gen_random_uuid(), 'BROADCAST', now(), $1) RETURNING id`, [txHash])).rows[0].id;
  const miner = (await db.query(
    `INSERT INTO miners (payout_address, network) VALUES ('ckb1qrecover', 'ckb')
     ON CONFLICT (payout_address) DO UPDATE SET last_seen_at = now() RETURNING id`)).rows[0].id;
  await db.query(
    `INSERT INTO payout_items (batch_id, miner_id, amount_shannons, state)
     VALUES ($1, $2, '100000000000', 'BROADCAST')`, [id, miner]);
  return { batchId: id, minerId: miner };
}

test('crash recovery', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  const quiet = { log: () => {} };
  const LIMITS = { maxBatchShannons: '200000000000', maxDailyShannons: '1000000000000' };

  await t.test('a broadcast batch whose tx is on chain is confirmed, not re-sent', async () => {
    await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
    const { batchId } = await seedBroadcastBatch(db, TX);
    const w = createPayoutWorker({ db, txBuilder: refuseToBuild, limits: LIMITS, logger: quiet });

    await w.recoverPendingBatches(makeNode({ committed: true }));

    const row = (await db.query(`SELECT state, confirmed_at FROM payout_batches WHERE id = $1`, [batchId])).rows[0];
    assert.strictEqual(row.state, 'CONFIRMED');
    assert.ok(row.confirmed_at);
    const paid = (await db.query(
      `SELECT COALESCE(sum(amount_shannons),0) s FROM ledger_entries WHERE account_type = $1`,
      [ACCOUNTS.PAID])).rows[0].s;
    assert.strictEqual(String(paid), '100000000000', 'confirmation must post the PAID entry exactly once');
  });

  await t.test('confirming twice posts nothing twice', async () => {
    await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
    await seedBroadcastBatch(db, TX);
    const w = createPayoutWorker({ db, txBuilder: refuseToBuild, limits: LIMITS, logger: quiet });
    await w.recoverPendingBatches(makeNode({ committed: true }));
    await w.recoverPendingBatches(makeNode({ committed: true }));
    const paid = (await db.query(
      `SELECT COALESCE(sum(amount_shannons),0) s FROM ledger_entries WHERE account_type = $1`,
      [ACCOUNTS.PAID])).rows[0].s;
    assert.strictEqual(String(paid), '100000000000', 'idempotency keys must prevent a double credit');
  });

  await t.test('a broadcast batch whose tx is absent stays BROADCAST for investigation', async () => {
    await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
    const { batchId } = await seedBroadcastBatch(db, TX);
    const w = createPayoutWorker({ db, txBuilder: refuseToBuild, limits: LIMITS, logger: quiet });

    await w.recoverPendingBatches(makeNode({ committed: false }));

    const row = (await db.query(`SELECT state FROM payout_batches WHERE id = $1`, [batchId])).rows[0];
    assert.strictEqual(row.state, 'BROADCAST',
      'an absent tx is missing evidence, not proof the payout failed — never mark it failed and re-pay');
  });

  await t.test('no new batch is created while a batch is unreconciled', async () => {
    await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, miners CASCADE');
    await seedBroadcastBatch(db, TX);
    const w = createPayoutWorker({ db, txBuilder: refuseToBuild, limits: LIMITS, logger: quiet });

    // refuseToBuild throws if a new batch is attempted; the node does not know
    // the tx, so the stuck batch cannot clear
    await w.runOnce(makeNode({ committed: false }));

    const { rows } = await db.query(`SELECT count(*)::int c FROM payout_batches`);
    assert.strictEqual(rows[0].c, 1, 'exactly the stuck batch — creating another risks paying twice');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --test-force-exit test/payout-recovery.test.js`
Expected: FAIL — `runOnce` does not take an rpc client, and recovery does not confirm by tx hash.

- [ ] **Step 3: Implement the reconciliation ordering**

In `runOnce`, before eligibility or batch creation:

```javascript
    // Reconcile anything unreconciled FIRST. A batch left RESERVED or
    // BROADCAST means either money moved and we failed to record it, or it
    // did not and we do not yet know. Creating a second batch in that state
    // is how a pool pays twice.
    await recoverPendingBatches(rpcClient);
    const stuck = (await db.query(
      `SELECT count(*)::int c FROM payout_batches WHERE state IN ('RESERVED','BROADCAST')`)).rows[0].c;
    if (stuck > 0) {
      logger.log('PAYOUT', `${stuck} unreconciled batch(es) — not creating another this pass`);
      return null;
    }
```

In `recoverPendingBatches`, for each `BROADCAST` batch with a `tx_hash`, call `get_transaction`. Committed → confirm the batch and post the `PAID` / `PENDING_PAYOUT` reversal entries with their existing idempotency keys. Absent or unknown → leave it exactly as it is and log; never mark it failed, because an absent transaction is missing evidence rather than proof the payout did not happen.

- [ ] **Step 4: Book the transaction fee (spec §6)**

The pool bears transaction fees. On confirmation, post the fee to `ACCOUNTS.TX_FEE` with idempotency key `payout:fee:${batchId}`, using the difference between the batch's input value and the sum of its outputs. Deducting it from miner balances instead would quietly shrink what miners were promised.

Add a subtest asserting a confirmed batch posts exactly one `tx_fee` entry, and that miners receive their full `amount_shannons` regardless of the fee.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --test-concurrency=1 --test-force-exit test/payout-recovery.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

Append `test/payout-recovery.test.js` to `test:db`.

```bash
npm run test:db
git add src/wallet/payout-worker.js test/payout-recovery.test.js package.json
git commit -m "wallet: reconcile broadcast batches against chain before creating another; book tx fees to the pool"
```

---

## Task 8: Cold sweep with trust-on-first-use

**Files:**
- Create: `src/wallet/sweep.js`
- Test: `test/sweep.test.js`

**Interfaces:**
- Consumes: `lockToAddress` (Task 1), `capVerdict` (Task 3)
- Produces: `sweepAmount({spendable, floatShannons, owedUnpaid})` → decimal string; `validateColdAddress(addr, network)` → lock; `checkColdAddressTofu(db, addr)` → `{ok, reason}`

- [ ] **Step 1: Write the failing test**

```javascript
// test/sweep.test.js
'use strict';
/**
 * sweep.test.js — surplus above a float moves to cold storage, but never at
 * the expense of what miners are owed, and never to an address that quietly
 * changed in configuration.
 */
const test = require('node:test');
const assert = require('node:assert');
const { sweepAmount, validateColdAddress } = require('../src/wallet/sweep.js');

test('sweeps only what exceeds the float', () => {
  assert.strictEqual(
    sweepAmount({ spendable: '900000000000', floatShannons: '500000000000', owedUnpaid: '0' }),
    '400000000000');
});

test('never sweeps funds owed to miners, even above the float', () => {
  // 9000 CKB spendable, 5000 float, 3000 owed -> only 1000 is genuinely surplus
  assert.strictEqual(
    sweepAmount({ spendable: '900000000000', floatShannons: '500000000000', owedUnpaid: '300000000000' }),
    '100000000000');
});

test('returns zero rather than a negative when there is no surplus', () => {
  assert.strictEqual(
    sweepAmount({ spendable: '100000000000', floatShannons: '500000000000', owedUnpaid: '0' }), '0');
  assert.strictEqual(
    sweepAmount({ spendable: '900000000000', floatShannons: '500000000000', owedUnpaid: '900000000000' }), '0');
});

test('a cold address must decode, checksum, and match the network', () => {
  assert.throws(() => validateColdAddress('ckb1qnonsense', 'ckb'), /checksum|decode/i);
  assert.throws(() => validateColdAddress('ckt1qyq9qjett7ngswt065q5t5ypk0p6c9sgqdlq8gfx5c', 'ckb'),
    /network|mainnet/i);
});

test('a valid mainnet address round-trips to itself', () => {
  const addr = 'ckb1qyq9qjett7ngswt065q5t5ypk0p6c9sgqdlq8gfx5c';
  const lock = validateColdAddress(addr, 'ckb');
  assert.match(lock.args, /^0x[0-9a-f]{40}$/);
});
```

- [ ] **Step 2: Run and see it fail**
- [ ] **Step 3: Implement**

```javascript
// src/wallet/sweep.js
'use strict';
/**
 * sweep.js — move surplus above a working float to cold storage.
 *
 * Two rules carry the safety here. Payouts always take priority over sweeps,
 * so the surplus subtracts what miners are owed even when it sits above the
 * float. And the cold address is trusted on FIRST USE: config tampering is
 * otherwise the one way to redirect funds without touching a line of code.
 */

const { lockToAddress } = require('./keystore.js');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

const HASH_TYPE_NAME = { 0: 'data', 1: 'type', 2: 'data1', 4: 'data2' };

/**
 * Surplus genuinely free to move: never the float, and never what miners are
 * owed. Returns a decimal string; zero when there is no surplus.
 */
function sweepAmount({ spendable, floatShannons, owedUnpaid }) {
  const surplus = BigInt(spendable) - BigInt(floatShannons) - BigInt(owedUnpaid);
  return (surplus > 0n ? surplus : 0n).toString();
}

/**
 * Decode, checksum, network-check and ROUND-TRIP a cold address.
 * A typo in a cold address is unrecoverable, so it is checked rather than
 * trusted: re-encoding the decoded lock must reproduce the input exactly.
 * @returns {{code_hash:string, hash_type:string, args:string}}
 */
function validateColdAddress(addr, network = 'ckb') {
  const pos = String(addr).lastIndexOf('1');
  if (pos < 1) throw new Error(`cold address does not decode: ${addr}`);
  const hrp = addr.slice(0, pos);
  const vals = [...addr.slice(pos + 1)].map(c => CHARSET.indexOf(c));
  if (vals.some(v => v < 0)) throw new Error(`cold address does not decode: invalid character`);

  const chk = polymod(hrpExpand(hrp).concat(vals));
  const isBech32 = chk === 1;
  const isBech32m = chk === 0x2bc830a3;
  if (!isBech32 && !isBech32m) throw new Error(`cold address checksum is invalid: ${addr}`);
  if (hrp !== network) {
    throw new Error(`cold address is for network "${hrp}" but this wallet is "${network}"`);
  }

  let acc = 0, bits = 0;
  const bytes = [];
  for (const v of vals.slice(0, -6)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  const buf = Buffer.from(bytes);
  if (buf[0] !== 0x00 || buf.length < 34) {
    throw new Error(`cold address is not a full-format CKB address: ${addr}`);
  }
  const lock = {
    code_hash: '0x' + buf.subarray(1, 33).toString('hex'),
    hash_type: HASH_TYPE_NAME[buf[33]],
    args: '0x' + buf.subarray(34).toString('hex'),
  };
  if (!lock.hash_type) throw new Error(`cold address has an unknown hash_type ${buf[33]}`);

  if (lockToAddress(lock, hrp) !== addr) {
    throw new Error(`cold address failed a round-trip check — refusing to treat it as valid: ${addr}`);
  }
  return lock;
}

/**
 * Trust on first use. The first address seen is recorded; a later change is
 * refused until an operator approves it, because a silently edited config is
 * indistinguishable from a tampered one.
 * @returns {{ok:boolean, reason:string|null}}
 */
async function checkColdAddressTofu(db, addr) {
  const { rows } = await db.query(
    `SELECT cold_address, approved_by FROM wallet_config WHERE id = 1`);
  if (rows.length === 0) {
    await db.query(
      `INSERT INTO wallet_config (id, cold_address) VALUES (1, $1)
       ON CONFLICT (id) DO NOTHING`, [addr]);
    return { ok: true, reason: null };
  }
  if (rows[0].cold_address === addr) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `cold address changed from ${rows[0].cold_address} to ${addr} — ` +
            `approve the change before any sweep (poolctl wallet approve-cold)`,
  };
}

/** What miners are owed and not yet paid: ledger balance plus anything in flight. */
async function owedUnpaidShannons(db, ACCOUNTS) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COALESCE(sum(amount_shannons), 0) FROM ledger_entries
         WHERE account_type = ANY($1)) AS ledger,
       (SELECT COALESCE(sum(i.amount_shannons), 0) FROM payout_items i
          JOIN payout_batches b ON b.id = i.batch_id
         WHERE b.state IN ('RESERVED','HELD','BROADCAST')) AS in_flight`,
    [[ACCOUNTS.CONFIRMED, ACCOUNTS.PENDING_PAYOUT]]);
  return (BigInt(rows[0].ledger) + BigInt(rows[0].in_flight)).toString();
}

module.exports = { sweepAmount, validateColdAddress, checkColdAddressTofu, owedUnpaidShannons };
```

- [ ] **Step 4: Run and see it pass**
- [ ] **Step 5: Add the sweep to the tick, behind arming**
- [ ] **Step 6: Commit**

```bash
npm test && npm run test:db
git add src/wallet/sweep.js src/wallet/main.js test/sweep.test.js package.json
git commit -m "wallet: cold sweep — never sweeps owed funds, cold address trusted on first use"
```

---

## Task 9: `poolctl wallet doctor | approve | sweep --dry-run`

**Files:**
- Modify: `src/accounting/poolctl.js`
- Test: `test/wallet-doctor.test.js`

**Interfaces:**
- Consumes: `loadKeystore`, `collectLiveCells`, `sweepAmount`, `dailySpentShannons`
- Produces: `walletDoctor({db, env})` → a report object; `approveBatch(db, batchId, who)`

`doctor` verifies, without moving anything: the key file is readable and its derived address (printed); the node and indexer are reachable and the indexer is not lagging the node; the cold address is valid and matches the TOFU record; the caps and float as configured; the current spendable balance and what a sweep would move; whether the wallet is armed. It is what an operator runs **before** arming.

- [ ] **Step 1: Write the failing test**

```javascript
// test/wallet-doctor.test.js
'use strict';
/**
 * wallet-doctor.test.js — the pre-flight an operator runs before arming.
 * Its whole value is that it reports problems rather than hiding them, so
 * the tests assert on the FAILING paths as hard as the passing one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { walletDoctor, approveBatch } = require('../src/accounting/poolctl.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const KEY = '0202020202020202020202020202020202020202020202020202020202020202';

let dbReady = false;
try { execSync('docker exec pool-pg-test pg_isready -U pool >/dev/null 2>&1'); dbReady = true; }
catch { dbReady = false; }

function keyFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  const p = path.join(dir, 'payout.privkey');
  fs.writeFileSync(p, KEY, { mode: 0o600 });
  return p;
}

test('wallet doctor', { timeout: 60000, skip: !dbReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);

  await t.test('reports the derived address and never the key', async () => {
    const r = await walletDoctor({ db, env: { POOL_WALLET_KEY: keyFile() } });
    assert.match(r.key.address, /^ckb1/);
    const dumped = JSON.stringify(r);
    assert.ok(!dumped.includes(KEY), 'the key must never reach the doctor output');
  });

  await t.test('reports not-armed when unarmed, and says so plainly', async () => {
    const r = await walletDoctor({ db, env: { POOL_WALLET_KEY: keyFile() } });
    assert.strictEqual(r.armed, false);
    assert.strictEqual(r.ok, false, 'an unarmed wallet is not ready to pay — that is not an error, but it is not ok');
  });

  await t.test('reports a missing key file as a problem, not a crash', async () => {
    const r = await walletDoctor({ db, env: { POOL_WALLET_KEY: '/nonexistent/k' } });
    assert.strictEqual(r.ok, false);
    assert.match(r.key.problem, /unreadable|key file/i);
  });

  await t.test('reports an invalid cold address as a problem', async () => {
    const r = await walletDoctor({
      db, env: { POOL_WALLET_KEY: keyFile(), POOL_WALLET_COLD_ADDRESS: 'ckb1qnonsense' } });
    assert.strictEqual(r.ok, false);
    assert.match(r.coldAddress.problem, /checksum|decode|invalid/i);
  });

  await t.test('approve refuses a batch that is not HELD', async () => {
    await db.query('TRUNCATE payout_items, payout_batches CASCADE');
    const id = (await db.query(
      `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'CONFIRMED') RETURNING id`)).rows[0].id;
    await assert.rejects(() => approveBatch(db, id, 'op'), /not HELD|HELD/i);
  });

  await t.test('approve stamps who released it and when', async () => {
    await db.query('TRUNCATE payout_items, payout_batches CASCADE');
    const id = (await db.query(
      `INSERT INTO payout_batches (id, state, held_reason) VALUES (gen_random_uuid(), 'HELD', 'per-batch cap') RETURNING id`)).rows[0].id;
    await approveBatch(db, id, 'phill@console');
    const row = (await db.query(`SELECT state, released_by, released_at FROM payout_batches WHERE id = $1`, [id])).rows[0];
    assert.strictEqual(row.state, 'RESERVED');
    assert.strictEqual(row.released_by, 'phill@console');
    assert.ok(row.released_at, 'the release must be stamped — it is the audit trail for money moving');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --test-force-exit test/wallet-doctor.test.js`
Expected: FAIL — `walletDoctor is not a function`

- [ ] **Step 3: Implement**

Add to `src/accounting/poolctl.js` and export both. The file already has a `require.main === module` guard from Plan 1, so importing it is inert.

```javascript
/**
 * Pre-flight for an operator about to arm the wallet.
 *
 * Never throws for an operational problem. A missing key, an unreachable
 * node, an invalid cold address are FINDINGS — each reported as a `problem`
 * string with `ok: false` overall — because a doctor that crashes on the
 * first fault tells you about one fault at a time. It throws only for a
 * programming error.
 */
async function walletDoctor({ db, env }) {
  const report = { ok: true, armed: false, key: {}, node: {}, coldAddress: {}, limits: {}, treasury: {} };
  const fail = (section, problem) => { report[section].problem = problem; report.ok = false; };

  // key -> address (never the key itself)
  if (!env.POOL_WALLET_KEY) {
    fail('key', 'POOL_WALLET_KEY is not set — the wallet cannot pay anyone');
  } else {
    try {
      const ks = loadKeystore({
        keyPath: env.POOL_WALLET_KEY,
        expectedAddress: env.POOL_WALLET_EXPECTED_ADDRESS || null,
        network: env.POOL_WALLET_NETWORK || 'ckb',
      });
      report.key.address = ks.address;
      report.key.lockArgs = ks.lock.args;
    } catch (e) { fail('key', e.message); }
  }

  // node + indexer reachability, and whether the indexer trails the node
  try {
    const tip = await rpcOnce(env.POOL_NODE_RPC, 'get_tip_header', []);
    report.node.tip = parseInt(tip.number, 16);
    const idx = await rpcOnce(env.POOL_INDEXER_URL || env.POOL_NODE_RPC, 'get_indexer_tip', []);
    report.node.indexerTip = parseInt(idx.block_number, 16);
    const lag = report.node.tip - report.node.indexerTip;
    report.node.indexerLag = lag;
    if (lag > 50) fail('node', `indexer is ${lag} blocks behind the node — cell selection would be stale`);
  } catch (e) { fail('node', `node or indexer unreachable: ${e.message}`); }

  // cold address: valid, and the one we recorded on first use
  if (!env.POOL_WALLET_COLD_ADDRESS) {
    report.coldAddress.note = 'not configured — sweeps disabled';
  } else {
    try {
      validateColdAddress(env.POOL_WALLET_COLD_ADDRESS, env.POOL_WALLET_NETWORK || 'ckb');
      report.coldAddress.address = env.POOL_WALLET_COLD_ADDRESS;
      const tofu = await checkColdAddressTofu(db, env.POOL_WALLET_COLD_ADDRESS);
      if (!tofu.ok) fail('coldAddress', tofu.reason);
    } catch (e) { fail('coldAddress', e.message); }
  }

  report.limits = {
    maxBatchShannons: env.POOL_WALLET_MAX_BATCH_SHANNONS || '200000000000',
    maxDailyShannons: env.POOL_WALLET_MAX_DAILY_SHANNONS || '1000000000000',
    floatShannons: env.POOL_WALLET_FLOAT_SHANNONS || '500000000000',
    dailySpent: await dailySpentShannons(db),
  };

  const owed = await owedUnpaidShannons(db, ACCOUNTS);
  const received = String((await db.query(
    `SELECT COALESCE(sum(amount_shannons), 0) s FROM treasury_receipts
      WHERE confirmed_at IS NOT NULL AND voided_at IS NULL`)).rows[0].s);
  report.treasury = { reconciledIncome: received, owedUnpaid: owed };
  if (BigInt(owed) > BigInt(received)) {
    fail('treasury', `owed ${owed} exceeds reconciled income ${received} — payouts would be refused`);
  }

  report.armed = env.POOL_WALLET_ARMED === '1' && env.POOL_WALLET_DRY_RUN !== '1';
  if (!report.armed) {
    report.ok = false;
    report.note = 'not armed — the wallet will build batches but move no money';
  }
  return report;
}

/** Release a HELD batch. Refuses anything else, so the state machine holds. */
async function approveBatch(db, batchId, who) {
  const r = await db.query(
    `UPDATE payout_batches SET state = 'RESERVED', released_by = $2, released_at = now()
      WHERE id = $1 AND state = 'HELD'`, [batchId, who]);
  if (r.rowCount === 0) {
    throw new Error(`batch ${batchId} is not HELD — nothing to release`);
  }
  return { batchId, released_by: who };
}
```

Then add `doctor`, `approve <batch>` and `sweep --dry-run` to `cmdWallet`, following the existing `cmd*` shape and JSON output style. `sweep --dry-run` prints what `sweepAmount` would move and to which address, and broadcasts nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 --test-force-exit test/wallet-doctor.test.js`
Expected: PASS, 6/6 subtests

- [ ] **Step 5: Commit**

Append `test/wallet-doctor.test.js` to `test:db`.

```bash
npm run test:db
git add src/accounting/poolctl.js test/wallet-doctor.test.js package.json
git commit -m "poolctl: wallet doctor, approve, sweep --dry-run"
```

---

## Task 10: Admin console — treasury views and the release action

**Files:**
- Modify: `src/api/admin-server.js`, `src/api/admin.html`
- Test: `test/admin.integration.test.js`

Add read views (treasury balance and spendable, income reconciliation per block, held and pending batches, sweep history) and one action: release a `HELD` batch, writing `released_by` from the authenticated operator and `released_at`.

The console must **not** call the wallet process. Release is a database row the wallet picks up on its next tick — the wallet listens on no port, and that is deliberate.

- [ ] **Step 1: Write the failing test**

```javascript
// append to test/admin.integration.test.js
//
// The release action is the only thing in the console that causes money to
// move. It is therefore the one endpoint whose auth and audit trail matter
// most, and the one most worth testing for what it REFUSES.

await t.test('GET treasury requires the admin token', async () => {
  const res = await fetch(`${base}/treasury`);          // no token
  assert.strictEqual(res.status, 401);
});

await t.test('GET treasury reports receipts and held batches', async () => {
  await db.query('TRUNCATE payout_items, payout_batches, treasury_receipts CASCADE');
  await db.query(
    `INSERT INTO payout_batches (id, state, held_reason)
     VALUES (gen_random_uuid(), 'HELD', 'per-batch cap exceeded')`);
  const res = await fetch(`${base}/treasury`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.held.length, 1);
  assert.match(body.held[0].held_reason, /per-batch/);
});

await t.test('release requires the admin token', async () => {
  const id = (await db.query(
    `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'HELD') RETURNING id`)).rows[0].id;
  const res = await fetch(`${base}/batches/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId: id }),
  });
  assert.strictEqual(res.status, 401);
  const row = (await db.query(`SELECT state FROM payout_batches WHERE id = $1`, [id])).rows[0];
  assert.strictEqual(row.state, 'HELD', 'an unauthenticated call must not release anything');
});

await t.test('release moves HELD to RESERVED and records who did it', async () => {
  const id = (await db.query(
    `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'HELD') RETURNING id`)).rows[0].id;
  const res = await fetch(`${base}/batches/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ batchId: id }),
  });
  assert.strictEqual(res.status, 200);
  const row = (await db.query(
    `SELECT state, released_by, released_at FROM payout_batches WHERE id = $1`, [id])).rows[0];
  assert.strictEqual(row.state, 'RESERVED');
  assert.ok(row.released_by, 'who released it must be recorded');
  assert.ok(row.released_at);
});

await t.test('release refuses a batch that is not HELD', async () => {
  const id = (await db.query(
    `INSERT INTO payout_batches (id, state) VALUES (gen_random_uuid(), 'CONFIRMED') RETURNING id`)).rows[0].id;
  const res = await fetch(`${base}/batches/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ batchId: id }),
  });
  assert.strictEqual(res.status, 409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --test-force-exit test/admin.integration.test.js`
Expected: FAIL — 404 on both new routes.

- [ ] **Step 3: Implement the routes**

Add `treasury` (GET) and `batches/release` (POST) to the `switch` in `src/api/admin-server.js`, following the existing route and auth shape. The release handler updates only `WHERE id = $1 AND state = 'HELD'`; a zero row count is a `409`, which is what makes the refusal test meaningful rather than a silent no-op.

Add the corresponding panels to `src/api/admin.html` following the existing table markup.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 --test-force-exit test/admin.integration.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run test:db
git add src/api/admin-server.js src/api/admin.html test/admin.integration.test.js
git commit -m "admin: treasury views and the HELD release action"
```

---

## Task 11: Dev-chain end-to-end payment

**Files:**
- Create: `test/wallet-e2e-devchain.test.js`
- Modify: `deploy/ckb-dev-test.sh` if it needs a wallet-specific fixture

**This is the gate for everything in this plan.** The project's history is unambiguous that mock chains prove nothing about acceptance: 224 passing mock tests missed two on-chain blockers in `subcell`; 56 passing tests were green while every real block submission was rejected in `proxy-server`. A payout that passes unit tests and is rejected by the node has not been tested.

Against the existing `pool-ckb-dev` container: mine blocks to the wallet's own derived lock, let the reconciler record receipts, arm the wallet, let it build and broadcast a real payout transaction, and assert on chain that the recipient received the expected capacity. Then assert the ledger moved `CONFIRMED → PENDING_PAYOUT → PAID` and that conservation holds.

- [ ] **Step 1: Write the end-to-end test**

```javascript
// test/wallet-e2e-devchain.test.js
'use strict';
/**
 * wallet-e2e-devchain.test.js — the only test on this branch that proves a
 * payout the CHAIN accepts.
 *
 * Every other suite here mocks the node, and a mock node performs no script
 * validation, no capacity checking, no cellbase-maturity rule and no fee
 * rule. This project's history is unambiguous about what that costs: 224
 * passing mock tests missed two on-chain blockers in `subcell`, and 56
 * passing tests were green while every real block submission was rejected in
 * `proxy-server`. A payout that passes unit tests and is rejected by the node
 * has not been tested.
 *
 * Requires the dev chain: `deploy/ckb-dev-test.sh`. Skips cleanly without it.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createDb } = require('../src/accounting/db.js');
const { loadKeystore } = require('../src/wallet/keystore.js');
const { createPayoutWorker } = require('../src/wallet/payout-worker.js');
const { createCkbInProcessBuilder } = require('../src/wallet/tx-builder-inprocess.js');
const { collectLiveCells, classifyCells } = require('../src/wallet/cells.js');
const { ACCOUNTS, verifyBlockConservation } = require('../src/accounting/ledger.js');
const { destructiveDbUrl } = require('./tools/test-db.js');

const DB_URL = destructiveDbUrl();
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const DEV_RPC = process.env.POOL_DEV_NODE_RPC || 'http://127.0.0.1:8115';
const DEV_KEY = process.env.POOL_DEV_KEY;   // set by deploy/ckb-dev-test.sh

let devReady = false;
try {
  execSync(`curl -s -m 3 -X POST ${DEV_RPC} -H 'content-type: application/json' ` +
           `-d '{"id":1,"jsonrpc":"2.0","method":"get_tip_header","params":[]}' | grep -q result`);
  devReady = Boolean(DEV_KEY);
} catch { devReady = false; }

test('end-to-end payout on the dev chain', { timeout: 300000, skip: !devReady }, async t => {
  const db = createDb(DB_URL);
  t.after(() => db.close());
  await db.migrate(MIGRATIONS);
  await db.query('TRUNCATE payout_items, payout_batches, ledger_entries, treasury_receipts, miners CASCADE');

  const ks = loadKeystore({ keyPath: DEV_KEY, network: 'ckt' });

  await t.test('the wallet can see its own mature cells', async () => {
    const raw = await collectLiveCells({ indexerUrl: DEV_RPC, lock: ks.lock, rpc: devRpc });
    const cells = classifyCells(raw);
    assert.ok(cells.length > 0, 'dev chain must have mined to our lock — check ckb-dev-test.sh block_assembler');
    assert.ok(cells.some(c => c.isCellbase), 'pool income is cellbase; none found');
  });

  await t.test('an armed wallet broadcasts a payout the chain accepts', async () => {
    const recipient = 'ckt1qyq...';   // a second dev address; see ckb-dev-test.sh
    const minerId = await seedMinerOwed(db, recipient, '70000000000');  // 700 CKB, over the min cell floor

    const txBuilder = createCkbInProcessBuilder({
      rpcUrl: DEV_RPC, indexerUrl: DEV_RPC, privateKeyPath: DEV_KEY, feeRateShannons: 1000,
    });
    const w = createPayoutWorker({
      db, txBuilder, logger: console,
      limits: { maxBatchShannons: '100000000000', maxDailyShannons: '1000000000000' },
    });

    const batch = await w.createBatch(await w.eligibleMiners());
    assert.strictEqual(batch.state, 'RESERVED');
    const { txHash } = await w.processBatch(batch.batchId);
    assert.match(txHash, /^0x[0-9a-f]{64}$/);

    // the chain is the assertion — not our own record of what we sent
    await waitForCommitted(txHash);
    const tx = await devRpc(DEV_RPC, 'get_transaction', [txHash]);
    assert.strictEqual(tx.tx_status.status, 'committed');
    const paidToRecipient = tx.transaction.outputs
      .filter(o => o.lock.args === lockArgsOf(recipient))
      .reduce((a, o) => a + BigInt(o.capacity), 0n);
    assert.strictEqual(paidToRecipient.toString(), '70000000000');
  });

  await t.test('the ledger moved CONFIRMED -> PENDING_PAYOUT -> PAID and conserves', async () => {
    const sums = {};
    for (const acct of [ACCOUNTS.CONFIRMED, ACCOUNTS.PENDING_PAYOUT, ACCOUNTS.PAID, ACCOUNTS.TX_FEE]) {
      sums[acct] = String((await db.query(
        `SELECT COALESCE(sum(amount_shannons),0) s FROM ledger_entries WHERE account_type = $1`,
        [acct])).rows[0].s);
    }
    assert.strictEqual(sums[ACCOUNTS.PENDING_PAYOUT], '0', 'pending must net to zero once paid');
    assert.strictEqual(sums[ACCOUNTS.PAID], '70000000000');
    assert.ok(BigInt(sums[ACCOUNTS.TX_FEE]) > 0n, 'the pool bears the fee, so it must be booked');
  });
});
```

Write the helpers (`devRpc`, `seedMinerOwed`, `waitForCommitted`, `lockArgsOf`) alongside, and fill the recipient address from whatever `deploy/ckb-dev-test.sh` provisions — read that script first rather than inventing an address.

- [ ] **Step 2: Run it against a running dev chain and watch it fail**

Run: `bash deploy/ckb-dev-test.sh` then `node --test --test-concurrency=1 --test-force-exit test/wallet-e2e-devchain.test.js`
Expected: FAIL initially. Record the node's actual rejection message in your report — that message is the most valuable output of this task, because it is the class of failure no mock produces.

- [ ] **Step 3: Fix whatever the chain rejects**

Likely candidates, in the order they usually bite: immature cellbase inputs; a fee below the pool's minimum rate; an output below the ~61 CKB minimum cell capacity; missing or wrong secp256k1 cell deps on a dev chain (the dev genesis has no dep groups — `resolveSecpDeps` already handles this, verify it does); a witness laid out wrongly for sighash_all.

- [ ] **Step 4: Run until the chain accepts it**

Expected: PASS, with a committed transaction hash in the report.

- [ ] **Step 5: Commit**

Append to `test:db` **only if** the dev chain is part of the standard local setup; otherwise add a separate `test:e2e` script so a missing dev chain never fails CI silently — a skipped test that looks passed is the failure mode this whole plan exists to avoid.

```bash
git add test/wallet-e2e-devchain.test.js package.json
git commit -m "wallet: end-to-end payout accepted by a real CKB node"
```

---

## Deliberately out of scope

- Multi-sig or hardware-wallet signing
- Notification channels (phone push, email) — the approval path is the console and `poolctl`
- A standalone wallet UI
- chain-pay integration (spec §12) — the `txBuilder` interface is the seam; a chain-pay backend would be a fourth implementation and would touch none of the reconciler, caps, sweep or state machine
- The slate wipe (spec §13) — its own spec
- Giving the wallet a read-only Postgres role for its non-spending queries (carried from Plan 1's review as a hardening item)
