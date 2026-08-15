'use strict';
/**
 * build-info.js — which commit is this process actually running?
 *
 * Why (incident 2026-08-14): the accounting service ran for two days on code
 * from before two critical nonce fixes. Node caches modules at require() time,
 * so "committed the fix" and "the fix is running" are different claims and
 * nothing in the system could tell them apart — the working tree was clean,
 * CI was green, and the service was quietly discarding won blocks.
 *
 * Resolving the commit AT STARTUP (not lazily) is the point: it captures the
 * tree as it was when the modules were loaded, so a later `git pull` cannot
 * make a stale process look current.
 *
 * Reads the git directory directly — no child processes, no git dependency at
 * runtime, safe when the deployment is a plain copy (returns null).
 */

const fs = require('node:fs');
const path = require('node:path');

const SHA_RE = /^[0-9a-f]{40}$/;

/** Resolve HEAD to a commit sha, following a symbolic ref into refs/ or packed-refs. */
function resolveHead(gitDir) {
  let head;
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); }
  catch { return null; }

  if (SHA_RE.test(head)) return head;              // detached HEAD

  const m = /^ref:\s*(.+)$/.exec(head);
  if (!m) return null;
  const ref = m[1].trim();

  try {
    const direct = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    if (SHA_RE.test(direct)) return direct;
  } catch { /* fall through to packed-refs */ }

  try {
    for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && SHA_RE.test(sha)) return sha;
    }
  } catch { /* no packed-refs */ }

  return null;
}

/**
 * @param {string} [root] repository root (defaults to this package's root)
 * @returns {{commit: string|null, commitShort: string|null, startedAt: string, pid: number}}
 */
function readBuildInfo(root = path.join(__dirname, '..', '..')) {
  const gitDir = path.join(root, '.git');
  const commit = resolveHead(gitDir);
  return {
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
}

// captured once, at module load — deliberately not re-read later
const BUILD_INFO = readBuildInfo();

module.exports = { BUILD_INFO, readBuildInfo, resolveHead };
