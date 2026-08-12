'use strict';
/**
 * block-service.js — periodic block lifecycle advancement for the accounting
 * process (spec 06 §2.3): canonical tracking → maturity → PPLNS allocation →
 * ledger, with conservation + state metrics.
 *
 * Wired into accounting/main.js; no other process advances block state, so
 * this is the single writer for block lifecycle (blocks rows guarded by
 * state transitions).
 */

const { createBlockTracker } = require('./block-tracker.js');
const { allocateMatureBlock } = require('./allocator.js');
const { verifyBlockConservation } = require('./ledger.js');

function createBlockService({ db, rpcClient, intervalMs = 15000, maturityEpochs = 4, feeBps = 100, windowNum = 2, windowDen = 1, logger = console, metrics = null }) {
  let timer = null;
  let stopped = false;

  const tracker = createBlockTracker({ db, rpcClient, maturityEpochs, logger });

  async function tick() {
    await tracker.tick();

    // orphaned-block counter (alert metric, spec 06 §9)
    const orph = await db.query(`SELECT count(*)::int c FROM blocks WHERE state = 'ORPHANED'`);
    metrics?.gauge?.('blocks_orphaned_total', orph.rows[0].c);

    // allocate any MATURE blocks (single-writer guard inside allocator)
    const { rows } = await db.query(`SELECT id FROM blocks WHERE state = 'MATURE'`);
    for (const b of rows) {
      const r = await allocateMatureBlock(db, { blockId: b.id, windowNum, windowDen, feeBps, logger });
      metrics?.inc?.('blocks_allocated_total', r.allocated ? 1 : 0);
    }

    // conservation audit over allocated blocks (alert metric, spec 06 §9)
    const audit = await db.query(
      `SELECT b.id, b.reward_shannons, b.state
       FROM blocks b WHERE b.state IN ('SETTLED_TO_LEDGER','ALLOCATED')`,
    );
    for (const b of audit.rows) {
      const ok = await verifyBlockConservation(db, b.id, b.reward_shannons);
      if (!ok) {
        metrics?.inc?.('ledger_conservation_failures_total');
        logger.log('AUDIT', `CONSERVATION FAILURE block ${b.id}`);
      }
    }

    // payout error visibility (batches stuck in error states)
    const perr = await db.query(
      `SELECT count(*)::int c FROM payout_batches WHERE state IN ('ERROR','BROADCAST') AND error IS NOT NULL`,
    );
    metrics?.gauge?.('payout_error_batches', perr.rows[0].c);
  }

  function start() {
    timer = setInterval(async () => {
      if (stopped) return;
      try { await tick(); }
      catch (e) { logger.log('BLOCK', `block-service tick failed: ${e.message}`); }
    }, intervalMs);
    timer.unref();
    // fire one tick immediately so a restart catches up quickly
    tick().catch(e => logger.log('BLOCK', `initial tick failed: ${e.message}`));
    return this;
  }

  function stop() { stopped = true; clearInterval(timer); }

  return { tick, start, stop, tracker };
}

module.exports = { createBlockService };
