'use strict';
/**
 * vardiff.js — per-miner variable difficulty controller.
 *
 * Extracted from ckb-stratum-proxy `solo-proxy.js` @ 4d57892 (`checkVardiff`,
 * `suggest_difficulty` handling, K7 seed) with NO behavior change. Clock is
 * injectable for deterministic tests.
 *
 * Behavior preserved:
 *  - retarget cadence: every `retargetSec` seconds;
 *  - window: shares since last retarget vs elapsed window seconds;
 *  - tolerance: no change when |actual - target| / target <= variancePercent;
 *  - adjustment: ratio clamped to [0.25, 4.0], diff clamped to [minDiff, maxDiff];
 *  - a changed diff is only *reported* (returned), the caller sends the wire
 *    messages (see vardiffMessagesFor);
 *  - `applySuggested` mirrors mining.suggest_difficulty handling (clamped,
 *    window/retarget reset, no change → still ACK'd by caller);
 *  - `seedForGodminer` mirrors the K7 subscribe-time seed (clamped
 *    godminerInitialDiff, window/retarget reset).
 */

function createVardiff(opts = {}, clock = () => Date.now()) {
  const targetShareSec   = opts.targetShareSec   || 30;
  const retargetSec      = opts.retargetSec      || 60;
  const variancePercent  = opts.variancePercent  || 30;
  const minDiff          = opts.minDiff          || 0.001;
  const maxDiff          = opts.maxDiff          || 1e9;
  const initialDiff      = opts.initialDiff      ?? 1.0;
  const godminerInitialDiff = opts.godminerInitialDiff ?? 65536;

  const now = clock();
  const state = {
    currentDiff: initialDiff,
    windowStart: now,
    sharesInWindow: 0,
    lastRetarget: now,
  };

  const clampDiff = d => Math.min(Math.max(d, minDiff), maxDiff);

  function resetWindow(t) {
    state.windowStart = t;
    state.sharesInWindow = 0;
    state.lastRetarget = t;
  }

  return {
    state,

    /** Record one submitted share (call before maybeRetarget, as upstream). */
    recordShare() { state.sharesInWindow++; },

    /**
     * Maybe adjust difficulty. Returns the new difficulty when it changed,
     * null otherwise. Mirrors checkVardiff exactly.
     */
    maybeRetarget(t = clock()) {
      if (t - state.lastRetarget < retargetSec * 1000) return null;
      const windowMs = t - state.windowStart;
      const shares   = state.sharesInWindow;
      const actual   = windowMs / 1000 / Math.max(shares, 1); // seconds/share
      const target   = targetShareSec;
      const variance = variancePercent / 100;

      resetWindow(t);

      if (Math.abs(actual - target) / target <= variance) return null;

      const ratio = Math.min(Math.max(target / actual, 0.25), 4.0);
      const newDiff = clampDiff(state.currentDiff * ratio);
      if (newDiff === state.currentDiff) return null;
      state.currentDiff = newDiff;
      return newDiff;
    },

    /** mining.suggest_difficulty: clamped honor with window reset. */
    applySuggested(suggested, t = clock()) {
      if (!(Number.isFinite(suggested) && suggested > 0)) return null;
      const clamped = clampDiff(suggested);
      const before  = state.currentDiff;
      state.currentDiff = clamped;
      resetWindow(t);
      return clamped === before ? clamped : clamped;
    },

    /** K7 subscribe-time seed: godminerInitialDiff clamped, window reset. */
    seedForGodminer(t = clock()) {
      const seeded = clampDiff(godminerInitialDiff);
      state.currentDiff = seeded;
      resetWindow(t);
      return seeded;
    },

    bounds: { minDiff, maxDiff, targetShareSec, retargetSec, variancePercent, initialDiff, godminerInitialDiff },
  };
}

module.exports = { createVardiff };
