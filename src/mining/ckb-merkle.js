'use strict';
/**
 * ckb-merkle.js — CKB header-root computation.
 *
 * A CKB block header commits to its body through three Byte32 fields that
 * `get_block_template` does NOT provide — the miner must compute them:
 *
 *   transactions_root = merkle_root([ raw_transactions_root, witnesses_root ])
 *                       where raw_transactions_root = CBMT(tx_hashes)
 *                             witnesses_root        = CBMT(tx_witness_hashes)
 *   proposals_hash    = zero if empty, else blake2b(concat of 10-byte ProposalShortIds)
 *   extra_hash        = uncles_hash                       (no extension)
 *                     = blake2b(uncles_hash || extension_hash)   (extension present)
 *                       where uncles_hash    = zero if empty, else
 *                                              blake2b(concat of uncle header hashes)
 *                             extension_hash = blake2b(extension raw bytes)
 *
 * tx_hash         = blake2b(molecule(RawTransaction))
 * tx_witness_hash = blake2b(molecule(Transaction))   // raw + witnesses
 *
 * All hashing is CKB blake2b-256 (personalization "ckb-default-hash").
 * CBMT = Complete Binary Merkle Tree, merge(l, r) = blake2b(l || r).
 *
 * Verified byte-for-byte against real mainnet blocks in test/ckb-merkle.test.js.
 *
 * Molecule schema references:
 *   https://github.com/nervosnetwork/ckb/blob/develop/util/gen-types/schemas/blockchain.mol
 */

const { ckbBlake2b } = require('./blake2b.js');

const ZERO32 = Buffer.alloc(32);

const HASH_TYPE = { data: 0x00, type: 0x01, data1: 0x02, data2: 0x04 };
const DEP_TYPE  = { code: 0x00, dep_group: 0x01 };

// ── low-level buffer helpers ────────────────────────────────────────────────
function bytesFromHex(hex) {
  return Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
}

function u32le(val) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(BigInt(val) & 0xffffffffn), 0);
  return b;
}

function u64le(val) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(val));
  return b;
}

// ── molecule containers ─────────────────────────────────────────────────────
/** fixvec: u32 item_count || concat(items)  (items are all fixed-size) */
function fixvec(items) {
  return Buffer.concat([u32le(items.length), ...items]);
}

/** Bytes (vector<byte>): u32 byte_length || raw_bytes */
function molBytes(hex) {
  const raw = bytesFromHex(hex);
  return Buffer.concat([u32le(raw.length), raw]);
}

/**
 * dynvec / table body: a length-prefixed, offset-indexed container.
 * total_size(4) || offset_i(4 each) || concat(fields)
 * Empty dynvec is a special case: just u32(4).
 */
function offsetContainer(fields) {
  if (fields.length === 0) return u32le(4);
  const headerSize = 4 + 4 * fields.length;
  const offsets = [];
  let cur = headerSize;
  for (const f of fields) {
    offsets.push(u32le(cur));
    cur += f.length;
  }
  const totalSize = cur;
  return Buffer.concat([u32le(totalSize), ...offsets, ...fields]);
}

// table and dynvec share the same wire layout (fixed field-set vs vector).
const table  = offsetContainer;
const dynvec = offsetContainer;

// ── molecule structs (bare concatenation, no header) ───────────────────────
function byte32(hex) {
  const b = bytesFromHex(hex);
  if (b.length !== 32) throw new Error(`Byte32 must be 32 bytes, got ${b.length}`);
  return b;
}

function outPoint(o) {
  return Buffer.concat([byte32(o.tx_hash), u32le(o.index)]); // 36 bytes
}

function cellInput(i) {
  return Buffer.concat([u64le(i.since), outPoint(i.previous_output)]); // 44 bytes
}

function cellDep(d) {
  const dt = DEP_TYPE[d.dep_type];
  if (dt === undefined) throw new Error(`unknown dep_type: ${d.dep_type}`);
  return Buffer.concat([outPoint(d.out_point), Buffer.from([dt])]); // 37 bytes
}

function script(s) {
  const ht = HASH_TYPE[s.hash_type];
  if (ht === undefined) throw new Error(`unknown hash_type: ${s.hash_type}`);
  return table([byte32(s.code_hash), Buffer.from([ht]), molBytes(s.args)]);
}

function scriptOpt(s) {
  return s ? script(s) : Buffer.alloc(0);
}

function cellOutput(o) {
  return table([u64le(o.capacity), script(o.lock), scriptOpt(o.type)]);
}

function rawTransaction(tx) {
  return table([
    u32le(tx.version),
    fixvec((tx.cell_deps   || []).map(cellDep)),
    fixvec((tx.header_deps || []).map(byte32)),
    fixvec((tx.inputs      || []).map(cellInput)),
    dynvec((tx.outputs     || []).map(cellOutput)),
    dynvec((tx.outputs_data|| []).map(molBytes)),
  ]);
}

function transaction(tx) {
  return table([rawTransaction(tx), dynvec((tx.witnesses || []).map(molBytes))]);
}

// ── public API ───────────────────────────────────────────────────────────────
/** blake2b(molecule(RawTransaction)) → 0x-hex */
function txHash(tx) {
  return '0x' + ckbBlake2b(rawTransaction(tx)).toString('hex');
}

/** blake2b(molecule(Transaction)) → 0x-hex */
function txWitnessHash(tx) {
  return '0x' + ckbBlake2b(transaction(tx)).toString('hex');
}

/**
 * Complete Binary Merkle Tree root over 32-byte leaves.
 * nodes[] has 2n-1 slots: leaves at [n-1, 2n-2], parents merged down to nodes[0].
 * merge(l, r) = blake2b(l || r). Empty → zero; single leaf → that leaf.
 * @param {Buffer[]} leaves
 * @returns {Buffer} 32-byte root
 */
function merkleRoot(leaves) {
  if (leaves.length === 0) return Buffer.from(ZERO32);
  if (leaves.length === 1) return leaves[0];
  const n = leaves.length;
  const nodes = new Array(n - 1).concat(leaves); // [ (n-1) holes , ...leaves ]
  for (let i = n - 2; i >= 0; i--) {
    nodes[i] = ckbBlake2b(Buffer.concat([nodes[2 * i + 1], nodes[2 * i + 2]]));
  }
  return nodes[0];
}

/**
 * transactions_root = merkle_root([ CBMT(tx_hashes), CBMT(tx_witness_hashes) ]).
 * @param {object[]} txs  transactions (cellbase first), CKB Transaction JSON shape
 * @returns {string} 0x-hex
 */
function calcTransactionsRoot(txs) {
  const txHashes    = txs.map(tx => bytesFromHex(txHash(tx)));
  const witnessHashes = txs.map(tx => bytesFromHex(txWitnessHash(tx)));
  const rawRoot     = merkleRoot(txHashes);
  const witnessRoot = merkleRoot(witnessHashes);
  return '0x' + merkleRoot([rawRoot, witnessRoot]).toString('hex');
}

/**
 * proposals_hash = zero if empty, else blake2b(concat of 10-byte ProposalShortIds).
 * @param {string[]} proposals  array of 0x-hex short ids
 * @returns {string} 0x-hex
 */
function calcProposalsHash(proposals) {
  if (!proposals || proposals.length === 0) return '0x' + ZERO32.toString('hex');
  const concat = Buffer.concat(proposals.map(bytesFromHex));
  return '0x' + ckbBlake2b(concat).toString('hex');
}

/**
 * uncles_hash = zero if empty, else blake2b(concat of uncle header hashes).
 * Accepts both RPC shapes:
 *   get_block:          { header: { hash } }
 *   get_block_template: { hash, header, proposals }  (top-level hash = header hash)
 * @param {object[]} uncles
 * @returns {string} 0x-hex
 */
function calcUnclesHash(uncles) {
  if (!uncles || uncles.length === 0) return '0x' + ZERO32.toString('hex');
  const headerHash = u => (u.header && u.header.hash) ? u.header.hash : u.hash;
  const concat = Buffer.concat(uncles.map(u => bytesFromHex(headerHash(u))));
  return '0x' + ckbBlake2b(concat).toString('hex');
}

// ── get_block_template wiring ───────────────────────────────────────────────
/**
 * Flatten a get_block_template result into its transaction list (cellbase first).
 * The template nests the real transactions under `.data`.
 */
function templateTransactions(tpl) {
  return [tpl.cellbase.data, ...(tpl.transactions || []).map(t => t.data)];
}

/**
 * Compute the RawHeader fields (no nonce) for a block template, including the
 * three body commitments the template does not provide. Feed to computePowHash.
 * @returns {object} fields for ckb-header.computePowHash
 */
function templateToHeaderFields(tpl) {
  const txs = templateTransactions(tpl);
  return {
    version          : tpl.version,
    compact_target   : tpl.compact_target,
    timestamp        : tpl.current_time,
    number           : tpl.number,
    epoch            : tpl.epoch,
    parent_hash      : tpl.parent_hash,
    transactions_root: calcTransactionsRoot(txs),
    proposals_hash   : calcProposalsHash(tpl.proposals || []),
    extra_hash       : calcExtraHash(calcUnclesHash(tpl.uncles || []), tpl.extension),
    dao              : tpl.dao,
  };
}

/**
 * Assemble the full Block object for the submit_block RPC from a template and a
 * solved nonce. Includes the cellbase (as transactions[0]), reconstructs uncle
 * blocks, and carries the extension so the node recomputes extra_hash identically.
 * @param {object} tpl       get_block_template result
 * @param {string} nonceHex  0x-prefixed nonce
 * @returns {object} Block for submit_block
 */
function buildBlockForSubmit(tpl, nonceHex) {
  const f = templateToHeaderFields(tpl);
  const block = {
    header: {
      version          : f.version,
      compact_target   : f.compact_target,
      timestamp        : f.timestamp,
      number           : f.number,
      epoch            : f.epoch,
      parent_hash      : f.parent_hash,
      transactions_root: f.transactions_root,
      proposals_hash   : f.proposals_hash,
      extra_hash       : f.extra_hash,
      dao              : f.dao,
      nonce            : nonceHex,
    },
    uncles      : (tpl.uncles || []).map(u => ({ header: u.header, proposals: u.proposals })),
    transactions: templateTransactions(tpl),
    proposals   : tpl.proposals || [],
  };
  if (tpl.extension !== undefined && tpl.extension !== null) {
    block.extension = tpl.extension;
  }
  return block;
}

/**
 * extra_hash = uncles_hash                              (no extension)
 *            = blake2b(uncles_hash || blake2b(ext))     (extension present)
 * @param {string} unclesHash  0x-hex uncles_hash
 * @param {string|null|undefined} extension  0x-hex extension bytes, or absent
 * @returns {string} 0x-hex
 */
function calcExtraHash(unclesHash, extension) {
  if (extension === undefined || extension === null) return unclesHash;
  const extHash = ckbBlake2b(bytesFromHex(extension));
  return '0x' + ckbBlake2b(Buffer.concat([bytesFromHex(unclesHash), extHash])).toString('hex');
}

module.exports = {
  merkleRoot,
  txHash,
  txWitnessHash,
  calcTransactionsRoot,
  calcProposalsHash,
  calcUnclesHash,
  calcExtraHash,
  templateTransactions,
  templateToHeaderFields,
  buildBlockForSubmit,
  // molecule builders — exported for payout transaction construction
  // (same code path that is pinned byte-for-byte by the txHash tests)
  rawTransaction,
  transaction,
  molBytes,
  fixvec,
  script,
  offsetContainer,
};
