'use strict';
/**
 * ckb-template.test.js — wiring layer: get_block_template → header roots → submit block.
 *
 * Strategy: reshape a REAL mined mainnet block into the exact shape
 * get_block_template returns, run it through the proxy's assembly functions,
 * and assert we reconstruct the block's ACTUAL network-accepted header and body.
 * If our reconstructed header equals the real header, submit_block would accept it.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  calcUnclesHash,
  templateToHeaderFields,
  buildBlockForSubmit,
} = require('../src/mining/ckb-merkle.js');

function load(name) {
  return require(`./fixtures/mainnet-${name}.json`);
}

/** Reshape a get_block block into a get_block_template-shaped object. */
function asTemplate(block) {
  const h = block.header;
  return {
    version: h.version,
    compact_target: h.compact_target,
    current_time: h.timestamp,
    number: h.number,
    epoch: h.epoch,
    parent_hash: h.parent_hash,
    dao: h.dao,
    work_id: '0x1',
    cellbase: { hash: block.transactions[0].hash, data: block.transactions[0] },
    transactions: block.transactions.slice(1).map(tx => ({ hash: tx.hash, data: tx })),
    proposals: block.proposals,
    // template uncles carry a top-level `hash` (the uncle header hash)
    uncles: block.uncles.map(u => ({ hash: u.header.hash, header: u.header, proposals: u.proposals })),
    extension: block.extension,
  };
}

const cellbaseOnly = load('block-raw');
const multitx      = load('multitx-5');
const proposals    = load('proposals');
const uncle        = load('uncle');

// ── calcUnclesHash tolerates the template uncle shape ──────────────────────
test('calcUnclesHash accepts template-shaped uncles ({hash}) identically', () => {
  const getBlockShape  = uncle.uncles;                                   // { header: { hash } }
  const templateShape  = uncle.uncles.map(u => ({ hash: u.header.hash })); // { hash }
  assert.strictEqual(calcUnclesHash(templateShape), calcUnclesHash(getBlockShape));
});

// ── templateToHeaderFields reproduces real header roots ────────────────────
for (const [name, block] of [['multitx', multitx], ['proposals', proposals], ['uncle', uncle], ['cellbaseOnly', cellbaseOnly]]) {
  test(`templateToHeaderFields reproduces all three roots for ${name}`, () => {
    const f = templateToHeaderFields(asTemplate(block));
    assert.strictEqual(f.transactions_root, block.header.transactions_root, 'transactions_root');
    assert.strictEqual(f.proposals_hash,    block.header.proposals_hash,    'proposals_hash');
    assert.strictEqual(f.extra_hash,        block.header.extra_hash,        'extra_hash');
  });
}

// ── buildBlockForSubmit reconstructs the exact network block ───────────────
test('buildBlockForSubmit reconstructs the real header field-for-field', () => {
  const block = multitx;
  const built = buildBlockForSubmit(asTemplate(block), block.header.nonce);
  const H = block.header;
  for (const k of ['version', 'compact_target', 'timestamp', 'number', 'epoch',
                   'parent_hash', 'transactions_root', 'proposals_hash', 'extra_hash', 'dao', 'nonce']) {
    assert.strictEqual(built.header[k], H[k], `header.${k}`);
  }
});

test('buildBlockForSubmit includes cellbase as transactions[0] and preserves order', () => {
  const block = multitx;
  const built = buildBlockForSubmit(asTemplate(block), block.header.nonce);
  assert.strictEqual(built.transactions.length, block.transactions.length);
  built.transactions.forEach((tx, i) => {
    // each reconstructed tx must be the exact tx that hashes to the real hash
    const { txHash } = require('../src/mining/ckb-merkle.js');
    assert.strictEqual(txHash(tx), block.transactions[i].hash, `tx[${i}]`);
  });
});

test('buildBlockForSubmit includes the extension when the template has one', () => {
  const built = buildBlockForSubmit(asTemplate(cellbaseOnly), cellbaseOnly.header.nonce);
  assert.strictEqual(built.extension, cellbaseOnly.extension);
});

test('buildBlockForSubmit omits extension when the template has none', () => {
  const t = asTemplate(multitx);
  delete t.extension;
  const built = buildBlockForSubmit(t, '0x0');
  assert.ok(!('extension' in built), 'extension must be absent, not null');
});

test('block hash = blake2b(full serialized header with nonce) matches real mainnet block', () => {
  const { ckbBlake2b } = require('../src/mining/blake2b.js');
  const { serializeFullHeader } = require('../src/mining/ckb-header.js');
  const block = require('./fixtures/mainnet-multitx-5.json');
  const H = block.header;
  const hash = ckbBlake2b(serializeFullHeader({
    version: H.version, compact_target: H.compact_target, timestamp: H.timestamp,
    number: H.number, epoch: H.epoch, parent_hash: H.parent_hash,
    transactions_root: H.transactions_root, proposals_hash: H.proposals_hash,
    extra_hash: H.extra_hash, dao: H.dao,
  }, H.nonce)).toString('hex');
  assert.strictEqual(hash, H.hash.replace(/^0x/, ''), 'header hash formula (canonicality check basis)');
});
