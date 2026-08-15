'use strict';
/**
 * build-info.test.js — the commit stamp that makes a stale process visible.
 * See src/common/build-info.js for the incident this exists for.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readBuildInfo, resolveHead, BUILD_INFO } = require('../src/common/build-info.js');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function tmpRepo(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildinfo-'));
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  build(path.join(root, '.git'));
  return root;
}

test('resolves a branch HEAD through refs/heads', () => {
  const root = tmpRepo(g => {
    fs.writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/master\n');
    fs.writeFileSync(path.join(g, 'refs', 'heads', 'master'), SHA + '\n');
  });
  assert.strictEqual(readBuildInfo(root).commit, SHA);
  assert.strictEqual(readBuildInfo(root).commitShort, 'aaaaaaa');
});

test('resolves a detached HEAD', () => {
  const root = tmpRepo(g => fs.writeFileSync(path.join(g, 'HEAD'), SHA + '\n'));
  assert.strictEqual(readBuildInfo(root).commit, SHA);
});

test('falls back to packed-refs when the loose ref is absent', () => {
  const root = tmpRepo(g => {
    fs.writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/master\n');
    fs.writeFileSync(path.join(g, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/other\n${SHA} refs/heads/master\n`);
  });
  assert.strictEqual(readBuildInfo(root).commit, SHA);
});

test('a non-git deployment reports null rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
  const info = readBuildInfo(root);
  assert.strictEqual(info.commit, null);
  assert.ok(info.startedAt, 'still reports when it started');
});

test('the stamp is captured at load, not re-read on access', () => {
  // this is the property that makes it useful: a `git pull` after startup must
  // NOT make a stale process start reporting the new commit
  const first = BUILD_INFO.commit;
  const second = require('../src/common/build-info.js').BUILD_INFO.commit;
  assert.strictEqual(first, second);
  assert.strictEqual(BUILD_INFO.pid, process.pid);
});

test('this repo stamps a real commit', () => {
  assert.match(readBuildInfo().commit, /^[0-9a-f]{40}$/);
});
