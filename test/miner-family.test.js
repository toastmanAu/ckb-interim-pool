'use strict';
/**
 * miner-family.test.js — pins the K7/GodMiner + Goldshell wire behavior
 * extracted from ckb-stratum-proxy solo-proxy.js @ 4d57892.
 *
 * The `solo-proxy differential` test re-implements the inline upstream logic
 * and (when ~/ckb-stratum-proxy-upstream is present) compares byte-for-byte
 * against the real upstream module, so refactors cannot drift silently.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  isGodMiner, leToBe, subscribeResponseFor, buildNotifyFor, composeNonce,
  vardiffMessagesFor, K7_DEFAULT_EXTRANONCE1,
} = require('../src/stratum/miner-family.js');
const { createVardiff } = require('../src/stratum/vardiff.js');
const { diffToTargetLE, hexLEToBigInt } = require('../src/mining/ckb-target.js');

// ── family classification ───────────────────────────────────────────────────
test('isGodMiner matches Bitmain K7 / GodMiner / ckbminer user agents', () => {
  assert.strictEqual(isGodMiner('GodMiner'), true);
  assert.strictEqual(isGodMiner('godminer-v0.4.7'), true);
  assert.strictEqual(isGodMiner('ckbminer-v1.0.0'), true);
  assert.strictEqual(isGodMiner('CkbMiner 1.2'), true);
  assert.strictEqual(isGodMiner('intminer/1.0.0'), false);
  assert.strictEqual(isGodMiner(''), false);
  assert.strictEqual(isGodMiner(undefined), false);
});

// ── leToBe ───────────────────────────────────────────────────────────────────
test('leToBe reverses byte order (64-char hex round-trip)', () => {
  const le = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef01122334455667788';
  assert.strictEqual(le.length, 64);
  assert.strictEqual(leToBe(leToBe(le)), le);
  assert.strictEqual(leToBe('0102'), '0201');
});

// ── subscribe wire shape (K7 3-tuple vs Goldshell nested tuple) ─────────────
test('K7 subscribe response: simple 3-tuple [null, extranonce1, 8]', () => {
  const r = subscribeResponseFor('godminer', 42, ['ckbminer-v1.0.0'], K7_DEFAULT_EXTRANONCE1);
  assert.deepStrictEqual(r, { id: 42, result: [null, '0011223344556677', 8], error: null });
  // 8 + 8 = 16 bytes of nonce composition
  assert.strictEqual(r.result[2], 8);
  assert.strictEqual(r.result[1].length, 16, 'extranonce1 is 8 bytes hex');
});

test('Goldshell subscribe response: nested 3-tuple with session id, size 4', () => {
  const r = subscribeResponseFor('goldshell', 7, ['intminer/1.0.0', 'deadbeef'], 'deadbeef');
  assert.deepStrictEqual(r, {
    id: 7,
    result: [
      [['mining.set_difficulty', 'deadbeef'], ['mining.notify', 'deadbeef']],
      'deadbeef',
      4,
    ],
    error: null,
  });
});

// ── notify endianness (K7 BE target on the wire, others LE) ─────────────────
test('notify: K7 gets byte-reversed (BE) target, Goldshell gets LE', () => {
  const job = { jobId: 0x1a, powHash: 'ab'.repeat(32), height: 12345, targetLE: 'cd'.repeat(32) };
  const k7 = buildNotifyFor('godminer', job, true);
  const gs = buildNotifyFor('goldshell', job, true);
  assert.strictEqual(k7.params[3], leToBe('cd'.repeat(32)), 'K7 target reversed');
  assert.strictEqual(gs.params[3], 'cd'.repeat(32), 'Goldshell target LE as-is');
  assert.deepStrictEqual(
    [k7.params[0], k7.params[1], k7.params[2], k7.params[4]],
    ['1a', 'ab'.repeat(32), 12345, true],
  );
});

test('notify returns null without a valid job', () => {
  assert.strictEqual(buildNotifyFor('goldshell', null, false), null);
  assert.strictEqual(buildNotifyFor('goldshell', { targetLE: undefined }, false), null);
});

// ── nonce composition (K7 16-byte full nonce vs zero-padded) ────────────────
test('K7 full nonce = extranonce1 || miner 8 bytes (16 bytes total)', () => {
  assert.strictEqual(composeNonce('godminer', '0011223344556677', '0xdeadbeefcafebabe'),
    '0011223344556677deadbeefcafebabe');
  assert.strictEqual(composeNonce('godminer', '0011223344556677', '0xdeadbeefcafebabe').length, 32);
});

test('non-K7 nonce zero-padded to 16 bytes', () => {
  assert.strictEqual(composeNonce('goldshell', 'ignored', '0xabc'),
    'abc'.padStart(32, '0'));
  assert.strictEqual(composeNonce('goldshell', 'ignored', '0xabc').length, 32);
});

test('composeNonce strips 0x prefix', () => {
  assert.strictEqual(composeNonce('goldshell', 'x', '0x1234'), '1234'.padStart(32, '0'));
});

// ── vardiff wire messages ────────────────────────────────────────────────────
test('vardiff: K7 gets set_target (BE) only; Goldshell gets set_target (LE) + set_difficulty', () => {
  const diff = 65536;
  const tLE = diffToTargetLE(diff);
  const k7 = vardiffMessagesFor('godminer', diff);
  const gs = vardiffMessagesFor('goldshell', diff);
  assert.deepStrictEqual(k7, [{ method: 'mining.set_target', params: [leToBe(tLE)] }]);
  assert.deepStrictEqual(gs, [
    { method: 'mining.set_target', params: [tLE] },
    { method: 'mining.set_difficulty', params: [diff] },
  ]);
});

// ── vardiff controller behavior (upstream checkVardiff semantics) ───────────
function clockFixture() {
  let t = 1_000_000;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('vardiff: no retarget before retargetSec elapses', () => {
  const c = clockFixture();
  const v = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 0.001, maxDiff: 1e9, initialDiff: 1 }, c.now);
  v.recordShare();
  assert.strictEqual(v.maybeRetarget(c.now() + 59_000), null);
});

test('vardiff: too fast (shares too frequent) raises difficulty', () => {
  const c = clockFixture();
  const v = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 0.001, maxDiff: 1e9, initialDiff: 1 }, c.now);
  // 60 shares in 60s → 1s/share vs 30s target → ratio = 30 → clamped 4x
  for (let i = 0; i < 60; i++) v.recordShare();
  const next = v.maybeRetarget(c.now() + 60_000);
  assert.strictEqual(next, 4);
});

test('vardiff: too slow (few shares) lowers difficulty (floor 0.25x)', () => {
  const c = clockFixture();
  const v = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 0.001, maxDiff: 1e9, initialDiff: 8 }, c.now);
  v.recordShare();
  // 1 share in 60s → 60s/share vs 30 → ratio = 0.5 → 4
  const next = v.maybeRetarget(c.now() + 60_000);
  assert.strictEqual(next, 4);
});

test('vardiff: within variance tolerance → no change', () => {
  const c = clockFixture();
  const v = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 0.001, maxDiff: 1e9, initialDiff: 1 }, c.now);
  // 2 shares in 60s → 30s/share → exactly on target
  v.recordShare(); v.recordShare();
  assert.strictEqual(v.maybeRetarget(c.now() + 60_000), null);
  assert.strictEqual(v.state.currentDiff, 1);
});

test('vardiff: clamps to min/max difficulty bounds', () => {
  const c = clockFixture();
  const v = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 10, maxDiff: 20, initialDiff: 10 }, c.now);
  for (let i = 0; i < 1000; i++) v.recordShare();
  assert.strictEqual(v.maybeRetarget(c.now() + 60_000), 20);
  const v2 = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 10, maxDiff: 20, initialDiff: 20 }, c.now);
  v2.recordShare();
  assert.strictEqual(v2.maybeRetarget(c.now() + 60_000), 10);
});

test('vardiff: suggest_difficulty honored with clamping and window reset', () => {
  const c = clockFixture();
  const v = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 1, maxDiff: 1000000, initialDiff: 1 }, c.now);
  assert.strictEqual(v.applySuggested(50000, c.now()), 50000);
  assert.strictEqual(v.state.currentDiff, 50000);
  assert.strictEqual(v.applySuggested(1e12, c.now()), 1000000, 'clamped to max');
  assert.strictEqual(v.applySuggested(0.0001, c.now()), 1, 'clamped to min');
  assert.strictEqual(v.applySuggested(-5, c.now()), null, 'invalid ignored');
  assert.strictEqual(v.applySuggested(NaN, c.now()), null);
  assert.strictEqual(v.applySuggested(Infinity, c.now()), null);
});

test('vardiff: K7 seed uses godminerInitialDiff clamped to bounds', () => {
  const c = clockFixture();
  const v = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 1, maxDiff: 100000, godminerInitialDiff: 65536, initialDiff: 1 }, c.now);
  assert.strictEqual(v.seedForGodminer(c.now()), 65536);
  const v2 = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 1, maxDiff: 1000, godminerInitialDiff: 65536, initialDiff: 1 }, c.now);
  assert.strictEqual(v2.seedForGodminer(c.now()), 1000);
});

test('vardiff: retarget window resets and continues converging', () => {
  const c = clockFixture();
  const v = createVardiff({ targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 0.001, maxDiff: 1e9, initialDiff: 1 }, c.now);
  c.advance(60_000);
  for (let i = 0; i < 60; i++) v.recordShare();
  assert.strictEqual(v.maybeRetarget(c.now()), 4);
  // after reset, 60 more shares in the next window → 16
  c.advance(60_000);
  for (let i = 0; i < 60; i++) v.recordShare();
  assert.strictEqual(v.maybeRetarget(c.now()), 16);
});

// ── differential test against the real upstream modules ─────────────────────
const fs = require('node:fs');
const path = require('node:path');
const UPSTREAM = path.join(require('os').homedir(), 'ckb-stratum-proxy-upstream');

test('differential: miner-family output matches upstream solo-proxy logic', { skip: !fs.existsSync(UPSTREAM) }, () => {
  const { diffToTargetLE: upDiffToTargetLE } = require(path.join(UPSTREAM, 'ckb-target.js'));

  // Upstream inline logic, transcribed verbatim (targets + messages)
  const upLeToBe = hex => {
    let be = '';
    for (let i = hex.length - 2; i >= 0; i -= 2) be += hex.slice(i, i + 2);
    return be;
  };
  const upCompose = (isGM, en1, nonce) => {
    const n8 = nonce.replace(/^0x/, '');
    return isGM ? (en1 || '0011223344556677') + n8 : n8.padStart(32, '0');
  };
  const upNotifyTarget = (isGM, targetLE) => isGM ? upLeToBe(targetLE) : targetLE;

  const samples = [
    ['godminer', '0011223344556677', '0xdeadbeefcafebabe'],
    ['godminer', '0011223344556677', '0x1'],
    ['goldshell', 'abc123', '0xdeadbeefcafebabe'],
    ['goldshell', 'abc123', '0x00'],
  ];
  for (const [family, en1, nonce] of samples) {
    const isGM = family === 'godminer';
    assert.strictEqual(composeNonce(family, en1, nonce), upCompose(isGM, en1, nonce));
  }
  for (const diff of [1, 0.001, 65536, 1e9, 470_000.5]) {
    const tLE = diffToTargetLE(diff);
    const upTLE = upDiffToTargetLE(diff);
    assert.strictEqual(tLE, upTLE, `diffToTargetLE(${diff})`);
    assert.strictEqual(leToBe(tLE), upLeToBe(upTLE), `target endianness for ${diff}`);
    for (const family of ['godminer', 'goldshell']) {
      const msgs = vardiffMessagesFor(family, diff);
      if (family === 'godminer') {
        assert.deepStrictEqual(msgs, [{ method: 'mining.set_target', params: [upLeToBe(upTLE)] }]);
      } else {
        assert.deepStrictEqual(msgs, [
          { method: 'mining.set_target', params: [upTLE] },
          { method: 'mining.set_difficulty', params: [diff] },
        ]);
      }
      const job = { jobId: 0x2b, powHash: 'ef'.repeat(32), height: 99, targetLE: upTLE };
      assert.strictEqual(buildNotifyFor(family, job, false).params[3], upNotifyTarget(family === 'godminer', upTLE));
    }
  }
});

test('differential: vardiff controller matches upstream checkVardiff', { skip: !fs.existsSync(UPSTREAM) }, () => {
  // Upstream checkVardiff, transcribed verbatim
  function upstreamCheck(miner, VARDIFF, now) {
    if (now - miner.vardiff.lastRetarget < VARDIFF.retargetSec * 1000) return null;
    const windowMs = now - miner.vardiff.windowStart;
    const shares = miner.vardiff.sharesInWindow;
    const actual = windowMs / 1000 / Math.max(shares, 1);
    const target = VARDIFF.targetShareSec;
    const variance = VARDIFF.variancePercent / 100;
    miner.vardiff.windowStart = now;
    miner.vardiff.sharesInWindow = 0;
    miner.vardiff.lastRetarget = now;
    if (Math.abs(actual - target) / target <= variance) return null;
    let ratio = Math.min(Math.max(target / actual, 0.25), 4.0);
    let newDiff = Math.min(Math.max(miner.vardiff.currentDiff * ratio, VARDIFF.minDiff), VARDIFF.maxDiff);
    if (newDiff === miner.vardiff.currentDiff) return null;
    miner.vardiff.currentDiff = newDiff;
    return newDiff;
  }

  const VARDIFF = { targetShareSec: 30, retargetSec: 60, variancePercent: 30, minDiff: 0.001, maxDiff: 1e9, initialDiff: 1.0 };
  for (let trial = 0; trial < 200; trial++) {
    const clock = { t: 1_000_000 + trial * 1000, now: () => clock.t };
    const v = createVardiff(VARDIFF, clock.now);
    const upstreamMiner = { vardiff: { currentDiff: 1, windowStart: clock.t, sharesInWindow: 0, lastRetarget: clock.t } };
    let step = 0;
    while (step++ < 20) {
      const shares = 1 + ((trial * 7 + step * 13) % 200);
      for (let i = 0; i < shares; i++) { v.recordShare(); upstreamMiner.vardiff.sharesInWindow++; }
      clock.t += 30_000 + ((trial + step) % 4) * 30_000;
      const mine = v.maybeRetarget(clock.now());
      const up = upstreamCheck(upstreamMiner, VARDIFF, clock.now());
      assert.strictEqual(mine, up, `trial ${trial} step ${step}`);
      assert.strictEqual(v.state.currentDiff, upstreamMiner.vardiff.currentDiff);
    }
  }
});
