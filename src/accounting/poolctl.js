#!/usr/bin/env node
'use strict';
/**
 * poolctl — operator CLI (spec 04 §14).
 *
 *   poolctl block show <hash>
 *   poolctl block recompute-allocation <hash>
 *   poolctl block recheck <hash|height>     (reopen an ORPHANED verdict)
 *   poolctl miner balance <address>
 *   poolctl ledger verify
 *   poolctl payout dry-run
 *   poolctl payout inspect <batch-id>
 *   poolctl events replay-status
 *   poolctl wallet status
 *   poolctl wallet receipts [height]
 *   poolctl wallet doctor
 *   poolctl wallet approve <batch-id>
 *   poolctl wallet sweep --dry-run
 *
 * Read-only except `block recheck` (reopens a verdict for re-verification)
 * and `wallet approve` (releases exactly one HELD payout with an operator
 * audit stamp). Both dry-run commands build reports and broadcast nothing.
 */

const { createDb } = require('./db.js');
const { allocateBlock } = require('../pplns/pplns.js');
const { compactToTargetLE } = require('../mining/ckb-target.js');
const { targetLEToWorkUnits } = require('../pplns/work-units.js');
const { balanceFor, verifyBlockConservation, auditableBlocks, ACCOUNTS } = require('./ledger.js');
const { createRpcClient } = require('../edge/rpc.js');
const { loadKeystore } = require('../wallet/keystore.js');
const { collectLiveCells, treasuryView } = require('../wallet/cells.js');
const { dailySpentShannons } = require('../wallet/caps.js');
const {
  sweepAmount,
  validateColdAddress,
  checkColdAddressTofu,
  owedUnpaidShannons,
} = require('../wallet/sweep.js');

const DB_URL = process.env.POOL_DB_URL || 'postgres://pool:pooltest@127.0.0.1:5433/pooltest';

const [,, cmd, ...rest] = process.argv;

async function main() {
  const db = createDb(DB_URL);
  try {
    switch (cmd) {
      case 'block': return await cmdBlock(db, rest);
      case 'miner': return await cmdMiner(db, rest);
      case 'ledger': return await cmdLedger(db, rest);
      case 'payout': return await cmdPayout(db, rest);
      case 'events': return await cmdEvents(db, rest);
      case 'wallet': return await cmdWallet(db, rest);
      default:
        console.error('usage: poolctl <block|miner|ledger|payout|events|wallet> …');
        process.exit(2);
    }
  } finally {
    await db.close();
  }
}

async function cmdBlock(db, [action, hash]) {
  if (action === 'show') {
    const rows = (await db.query(
      `SELECT id::text, state, height, block_hash, reward_shannons, edge_id, found_at,
              node_accepted_at, matured_at, orphaned_at, candidate_event_id::text
       FROM blocks WHERE block_hash = $1 OR id::text = $1`, [hash],
    )).rows;
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (action === 'recompute-allocation') {
    const b = (await db.query(`SELECT * FROM blocks WHERE block_hash = $1 OR id::text = $1`, [hash])).rows[0];
    if (!b) { console.error('block not found'); process.exit(1); }
    const stored = (await db.query(`SELECT * FROM block_allocations WHERE block_id = $1`, [b.id])).rows[0];
    const shares = (await db.query(
      `SELECT id::text share_id, miner_id::text miner, work_units::text work_units
       FROM share_events WHERE accepted_at <= (SELECT accepted_at FROM share_events WHERE id = $1)
       ORDER BY accepted_at, edge_id, boot_id, edge_seq`,
      [b.candidate_event_id],
    )).rows;
    const template = typeof b.template_json === 'string' ? JSON.parse(b.template_json) : b.template_json;
    const netWork = targetLEToWorkUnits(compactToTargetLE(parseInt(template.compact_target, 16))).toString();
    const recomputed = allocateBlock({
      rewardShannons: b.reward_shannons,
      feeBps: stored ? (await db.query(`SELECT fee_bps FROM config_snapshots WHERE id = $1`, [b.config_snapshot_id])).rows[0]?.fee_bps ?? 100 : 100,
      windowNum: 2, windowDen: 1,
      networkWork: netWork,
      orderedShares: shares.map(s => ({ shareId: s.share_id, miner: s.miner, workUnits: s.work_units })),
    });
    const match = stored && stored.allocation_hash === recomputed.allocationHash;
    console.log(JSON.stringify({ stored_hash: stored?.allocation_hash, recomputed_hash: recomputed.allocationHash, match }, null, 2));
    return;
  }
  if (action === 'recheck') {
    // Reopen an ORPHANED verdict for re-verification against the chain.
    //
    // The tracker corrects its own mistakes automatically only while a block
    // is within orphanRecheckDepth of the tip; past that the verdict is final
    // by design (re-polling every historical orphan forever is unbounded
    // work). This is the deliberate, audited way to reopen an older one —
    // needed on 2026-08-15 to recover two canonical blocks written off by a
    // stale tracker four days deep.
    //
    // It does NOT decide anything: it resets the row to NODE_ACCEPTED and
    // lets the running tracker prove canonicality against the node. If the
    // block really was orphaned, the next tick marks it ORPHANED again.
    const b = (await db.query(
      `SELECT id::text, height, state FROM blocks WHERE block_hash = $1 OR id::text = $1 OR height::text = $1`,
      [hash],
    )).rows[0];
    if (!b) { console.error('block not found'); process.exit(1); }
    if (b.state !== 'ORPHANED') {
      console.error(`block ${b.height} is ${b.state}, not ORPHANED — nothing to recheck`);
      process.exit(1);
    }
    await db.query(
      `UPDATE blocks SET state = 'NODE_ACCEPTED', orphaned_at = NULL WHERE id = $1 AND state = 'ORPHANED'`,
      [b.id],
    );
    console.log(JSON.stringify({
      block: b.id, height: b.height, from: 'ORPHANED', to: 'NODE_ACCEPTED',
      note: 'the tracker will re-verify against the node on its next tick; run `poolctl block show` to see the verdict',
    }, null, 2));
    return;
  }
  console.error('usage: poolctl block <show|recompute-allocation|recheck> <hash|height>');
  process.exit(2);
}

async function cmdMiner(db, [action, address]) {
  if (action === 'balance') {
    const m = (await db.query(`SELECT id FROM miners WHERE payout_address = $1`, [address])).rows[0];
    if (!m) { console.log(JSON.stringify({ address, error: 'unknown miner' })); return; }
    const out = {};
    for (const [k, v] of Object.entries(ACCOUNTS)) {
      out[k.toLowerCase()] = (await balanceFor(db, m.id, [v])).toString();
    }
    out.payout_address = address;
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.error('usage: poolctl miner balance <address>');
  process.exit(2);
}

async function cmdLedger(db) {
  // Only blocks that have been ALLOCATED have ledger entries to conserve. A
  // canonical-but-immature block legitimately has a reward and no entries —
  // auditing it reports a "CONSERVATION FAILURE" for a block that is simply
  // waiting for maturity. This must match block-service.js's audit scope; if
  // the operator's audit tool cries wolf, the LedgerConservation alert ("STOP
  // payouts until audited") becomes unactionable.
  const blocks = await auditableBlocks(db);
  let ok = true;
  for (const b of blocks) {
    const conserved = await verifyBlockConservation(db, b.id, b.reward_shannons);
    if (!conserved) { ok = false; console.error(`CONSERVATION FAILURE: block ${b.id}`); }
  }
  // reported, not audited: visible so an allocation that never runs cannot
  // hide behind an empty check
  const pending = (await db.query(
    `SELECT count(*)::int c
       FROM blocks b
       JOIN treasury_receipts r ON r.block_id = b.id
      WHERE b.state NOT IN ('ALLOCATED', 'SETTLED_TO_LEDGER')
        AND r.confirmed_at IS NOT NULL AND r.voided_at IS NULL`,
  )).rows[0].c;
  const entries = (await db.query(`SELECT count(*)::int c FROM ledger_entries`)).rows[0].c;
  const dupKeys = (await db.query(
    `SELECT idempotency_key, count(*) c FROM ledger_entries GROUP BY idempotency_key HAVING count(*) > 1`,
  )).rows;
  console.log(JSON.stringify({
    blocks_checked: blocks.length,
    conserved: ok,
    blocks_awaiting_allocation: pending,
    ledger_entries: entries,
    duplicate_idempotency_keys: dupKeys.length,
  }, null, 2));
  if (!ok || dupKeys.length > 0) process.exit(1);
}

async function cmdPayout(db, [action, batchId]) {
  if (action === 'inspect') {
    const batch = (await db.query(`SELECT * FROM payout_batches WHERE id::text = $1 OR tx_hash = $1`, [batchId])).rows;
    const items = batch[0] ? (await db.query(`SELECT * FROM payout_items WHERE batch_id = $1`, [batch[0].id])).rows : [];
    console.log(JSON.stringify({ batch, items }, null, 2));
    return;
  }
  if (action === 'dry-run') {
    const eligible = (await db.query(
      `SELECT m.payout_address, sum(l.amount_shannons)::text amount
       FROM ledger_entries l JOIN miners m ON m.id = l.miner_id
       WHERE l.account_type = $1 GROUP BY m.payout_address
       HAVING sum(l.amount_shannons) >= $2 ORDER BY m.payout_address`,
      [ACCOUNTS.CONFIRMED, '100000000000'],
    )).rows;
    console.log(JSON.stringify({ dry_run: true, broadcast_nothing: true, recipients: eligible.length, eligible }, null, 2));
    return;
  }
  console.error('usage: poolctl payout <inspect <batch-id>|dry-run>');
  process.exit(2);
}

async function cmdEvents(db) {
  const perEdge = (await db.query(
    `SELECT edge_id, boot_id, count(*)::int events, max(edge_seq) max_seq FROM ingested_events
     GROUP BY edge_id, boot_id ORDER BY edge_id`,
  )).rows;
  console.log(JSON.stringify({ per_edge: perEdge }, null, 2));
}

/**
 * `poolctl wallet status` — the reconciler's own view of its work, plus the
 * one liability comparison this plan can actually make.
 *
 * Exported so the counts can be tested: an operator check that prints 0 while
 * a block is permanently stuck is worse than no check at all.
 */
async function walletStatus(db) {
  const r = (await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE confirmed_at IS NOT NULL AND voided_at IS NULL)::int confirmed,
            count(*) FILTER (WHERE confirmed_at IS NULL AND voided_at IS NULL)::int pending,
            count(*) FILTER (WHERE voided_at IS NOT NULL)::int voided,
            COALESCE(sum(amount_shannons) FILTER (WHERE confirmed_at IS NOT NULL AND voided_at IS NULL), 0) received
       FROM treasury_receipts`)).rows[0];

  // Liabilities are what the pool owes miners RIGHT NOW: credited but not yet
  // batched (miner_confirmed) PLUS already batched and not yet paid
  // (miner_pending_payout) — the payout worker debits the first into the
  // second, so counting only the first makes the comparison drift downwards
  // with every batch.
  const owed = (await db.query(
    `SELECT COALESCE(sum(amount_shannons), 0) owed FROM ledger_entries
      WHERE account_type = ANY($1)`, [[ACCOUNTS.CONFIRMED, ACCOUNTS.PENDING_PAYOUT]])).rows[0].owed;

  // Mirrors the reconciler's own work set exactly (src/wallet/reconciler.js
  // tick()): every state it scans, and "no CONFIRMED un-voided receipt" as
  // the predicate. Counting only `r.id IS NULL` over MATURE-and-later
  // undercounted three ways — CANONICAL_IMMATURE blocks were invisible,
  // as were blocks holding a merely pending receipt, as were blocks whose
  // receipt had been VOIDED (precisely the stuck ones).
  const awaiting = (await db.query(
    `SELECT count(*)::int c FROM blocks b
      WHERE b.height IS NOT NULL
        AND b.state IN ('CANONICAL_IMMATURE','MATURE','ALLOCATED','SETTLED_TO_LEDGER')
        AND NOT EXISTS (
          SELECT 1 FROM treasury_receipts r
           WHERE r.block_id = b.id
             AND r.confirmed_at IS NOT NULL AND r.voided_at IS NULL)`)).rows[0].c;

  // reported separately: a block whose payout was voided and not yet
  // re-recorded is a distinct condition from one simply not reached yet
  const voidedBlocks = (await db.query(
    `SELECT count(*)::int c FROM blocks b
      WHERE EXISTS (SELECT 1 FROM treasury_receipts r
                     WHERE r.block_id = b.id AND r.voided_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM treasury_receipts r
                         WHERE r.block_id = b.id AND r.voided_at IS NULL)`)).rows[0].c;

  return {
    receipts: r,
    owed_shannons: String(owed),
    blocks_awaiting_reconciliation: awaiting,
    blocks_with_voided_receipts: voidedBlocks,
    // NOT solvency. `received` is LIFETIME confirmed income and only ever
    // rises; liabilities fall as payouts settle. Once payouts have run the
    // comparison latches true regardless of what the treasury actually holds.
    // The real check needs the on-chain balance of the treasury lock, which
    // needs an indexer — Plan 2.
    lifetime_income_covers_current_liabilities: BigInt(r.received) >= BigInt(owed),
    note: 'not an on-chain balance check — see Plan 2',
  };
}

/** One JSON-RPC request to an explicit private CKB node or indexer URL. */
async function rpcOnce(url, method, params) {
  if (!url) throw new Error(`RPC URL is not configured for ${method}`);
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:') {
    throw new Error(`unsupported RPC protocol ${endpoint.protocol}`);
  }
  return createRpcClient({
    host: endpoint.hostname,
    port: parseInt(endpoint.port || '8114', 10),
  }).rpc(method, params);
}

function configuredShannons(value, fallback, field) {
  const selected = value ?? fallback;
  if (typeof selected !== 'string' || !/^\d+$/.test(selected)) {
    throw new Error(`${field} must be a non-negative decimal shannon string`);
  }
  return selected;
}

/**
 * Pre-flight for an operator about to arm the wallet.
 *
 * Operational faults are findings rather than exceptions so one run reports
 * every problem it can safely discover. Private key bytes remain local to
 * the keystore result and are never copied into the report.
 */
async function walletDoctor({
  db,
  env,
  rpc = rpcOnce,
  loadKeystoreFn = loadKeystore,
  collectLiveCellsFn = collectLiveCells,
}) {
  if (!db || !env) throw new Error('walletDoctor requires db and env');
  const report = {
    ok: true,
    armed: false,
    key: {},
    node: {},
    coldAddress: {},
    limits: {},
    treasury: {},
  };
  const fail = (section, problem) => {
    report[section].problem = String(problem);
    report.ok = false;
  };

  let keystore = null;
  if (!env.POOL_WALLET_KEY) {
    fail('key', 'POOL_WALLET_KEY is not set — the wallet cannot sign payouts');
  } else {
    try {
      keystore = loadKeystoreFn({
        keyPath: env.POOL_WALLET_KEY,
        expectedAddress: env.POOL_WALLET_EXPECTED_ADDRESS || null,
        network: env.POOL_WALLET_NETWORK || 'ckb',
      });
      report.key.address = keystore.address;
      report.key.lockArgs = keystore.lock.args;
    } catch (error) {
      fail('key', error.message);
    }
  }

  const nodeUrl = env.POOL_NODE_RPC;
  const indexerUrl = env.POOL_INDEXER_URL;
  let tip = null;
  try {
    if (!nodeUrl) throw new Error('POOL_NODE_RPC is not set');
    if (!indexerUrl) throw new Error('POOL_INDEXER_URL is not set');
    tip = await rpc(nodeUrl, 'get_tip_header', []);
    const indexerTip = await rpc(indexerUrl, 'get_indexer_tip', []);
    const nodeHeight = Number.parseInt(tip?.number, 16);
    const indexerHeight = Number.parseInt(indexerTip?.block_number, 16);
    if (!Number.isSafeInteger(nodeHeight) || !Number.isSafeInteger(indexerHeight)) {
      throw new Error('node or indexer returned an invalid tip height');
    }
    const maxLag = Number.parseInt(env.POOL_WALLET_MAX_INDEXER_LAG || '50', 10);
    if (!Number.isSafeInteger(maxLag) || maxLag < 0) {
      throw new Error('POOL_WALLET_MAX_INDEXER_LAG must be a non-negative integer');
    }
    report.node.tip = nodeHeight;
    report.node.indexerTip = indexerHeight;
    report.node.indexerLag = nodeHeight - indexerHeight;
    report.node.maxIndexerLag = maxLag;
    if (report.node.indexerLag > maxLag) {
      fail('node', `indexer is ${report.node.indexerLag} blocks behind the node; cell selection is stale`);
    }
  } catch (error) {
    fail('node', `node or indexer unreachable or invalid: ${error.message}`);
  }

  if (!env.POOL_WALLET_COLD_ADDRESS) {
    report.coldAddress.note = 'not configured — cold sweeps are disabled';
  } else {
    try {
      validateColdAddress(env.POOL_WALLET_COLD_ADDRESS, env.POOL_WALLET_NETWORK || 'ckb');
      report.coldAddress.address = env.POOL_WALLET_COLD_ADDRESS;
      const tofu = await checkColdAddressTofu(db, env.POOL_WALLET_COLD_ADDRESS);
      if (!tofu.ok) fail('coldAddress', tofu.reason);
      else report.coldAddress.tofuMatch = true;
    } catch (error) {
      fail('coldAddress', error.message);
    }
  }

  try {
    const dailySpent = await dailySpentShannons(db);
    report.limits = {
      maxBatchShannons: configuredShannons(
        env.POOL_WALLET_MAX_BATCH_SHANNONS, '200000000000', 'POOL_WALLET_MAX_BATCH_SHANNONS'),
      maxDailyShannons: configuredShannons(
        env.POOL_WALLET_MAX_DAILY_SHANNONS, '1000000000000', 'POOL_WALLET_MAX_DAILY_SHANNONS'),
      floatShannons: configuredShannons(
        env.POOL_WALLET_FLOAT_SHANNONS, '500000000000', 'POOL_WALLET_FLOAT_SHANNONS'),
      dailySpent,
      dailySpentShannons: dailySpent,
    };
  } catch (error) {
    fail('limits', error.message);
  }

  try {
    const owed = await owedUnpaidShannons(db, ACCOUNTS);
    const reconciledIncome = String((await db.query(
      `SELECT COALESCE(sum(amount_shannons), 0) AS received
         FROM treasury_receipts
        WHERE confirmed_at IS NOT NULL AND voided_at IS NULL`,
    )).rows[0].received);
    report.treasury.reconciledIncome = reconciledIncome;
    report.treasury.owedUnpaid = owed;
    report.treasury.owedUnpaidShannons = owed;
    if (BigInt(owed) > BigInt(reconciledIncome)) {
      fail('treasury', `owed ${owed} exceeds reconciled income ${reconciledIncome}`);
    }
    if (keystore && tip && !report.node.problem) {
      if (!tip.epoch) throw new Error('node tip has no epoch for maturity calculation');
      const rawCells = await collectLiveCellsFn({
        indexerUrl,
        nodeUrl,
        lock: keystore.lock,
        rpc,
      });
      const view = treasuryView({ rawCells, tipEpochHex: tip.epoch });
      report.treasury.totalShannons = view.total;
      report.treasury.spendableShannons = view.spendable;
      report.treasury.cellCount = view.cellCount;
      if (report.limits.floatShannons) {
        report.treasury.sweepShannons = sweepAmount({
          spendable: view.spendable,
          floatShannons: report.limits.floatShannons,
          owedUnpaid: owed,
        });
      }
      if (BigInt(view.spendable) < BigInt(owed)) {
        fail('treasury', `spendable ${view.spendable} is below unpaid miner liabilities ${owed}`);
      }
    }
  } catch (error) {
    fail('treasury', error.message);
  }

  report.armed = env.POOL_WALLET_ARMED === '1' && env.POOL_WALLET_DRY_RUN !== '1';
  if (!report.armed) {
    report.ok = false;
    report.note = 'not armed — the wallet can inspect and build, but broadcasts no payout or sweep';
  }
  return report;
}

/** Release exactly one HELD batch and preserve who authorized the movement. */
async function approveBatch(db, batchId, who) {
  if (!batchId) throw new Error('a payout batch id is required');
  if (typeof who !== 'string' || who.trim() === '') throw new Error('operator identity is required');
  const result = await db.query(
    `UPDATE payout_batches
        SET state = 'RESERVED', released_by = $2, released_at = now()
      WHERE id = $1 AND state = 'HELD'
      RETURNING id::text`,
    [batchId, who.trim()],
  );
  if (result.rowCount === 0) {
    throw new Error(`batch ${batchId} is not HELD — nothing to release`);
  }
  return { batchId: result.rows[0].id, releasedBy: who.trim() };
}

/** Compute the sweep from the same live preflight data; never constructs a transaction. */
async function walletSweepDryRun(options) {
  const report = await walletDoctor(options);
  const unsafeFindings = ['key', 'node', 'coldAddress', 'limits', 'treasury']
    .filter(section => report[section]?.problem)
    .map(section => `${section}: ${report[section].problem}`);
  if (unsafeFindings.length > 0) {
    throw new Error(`cannot preview cold sweep; ${unsafeFindings.join('; ')}`);
  }
  const required = [
    ['cold address', report.coldAddress.address],
    ['spendable balance', report.treasury.spendableShannons],
    ['float', report.limits.floatShannons],
    ['unpaid liabilities', report.treasury.owedUnpaidShannons],
    ['sweep amount', report.treasury.sweepShannons],
  ];
  const missing = required.filter(([, value]) => value == null).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`cannot preview cold sweep; unavailable: ${missing.join(', ')}`);
  }
  return {
    dryRun: true,
    broadcastNothing: true,
    coldAddress: report.coldAddress.address,
    spendableShannons: report.treasury.spendableShannons,
    floatShannons: report.limits.floatShannons,
    owedUnpaidShannons: report.treasury.owedUnpaidShannons,
    sweepShannons: report.treasury.sweepShannons,
  };
}

async function cmdWallet(db, [action, arg]) {
  if (action === 'status') {
    console.log(JSON.stringify(await walletStatus(db), null, 2));
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
  if (action === 'doctor') {
    console.log(JSON.stringify(await walletDoctor({ db, env: process.env }), null, 2));
    return;
  }
  if (action === 'approve') {
    const who = process.env.POOL_OPERATOR_ID || process.env.USER;
    console.log(JSON.stringify(await approveBatch(db, arg, who), null, 2));
    return;
  }
  if (action === 'sweep' && arg === '--dry-run') {
    console.log(JSON.stringify(await walletSweepDryRun({ db, env: process.env }), null, 2));
    return;
  }
  console.error('usage: poolctl wallet <status|receipts [height]|doctor|approve <batch-id>|sweep --dry-run>');
  process.exit(2);
}

// only when run as the CLI: requiring this module (tests, tooling) must not
// execute a command or exit the process
if (require.main === module) {
  main().catch(e => { console.error('poolctl error:', e.message); process.exit(1); });
}

module.exports = {
  walletStatus,
  walletDoctor,
  approveBatch,
  walletSweepDryRun,
  rpcOnce,
};
