'use strict';
/**
 * ckb-tx-builder.js — self-contained CKB payout transaction construction,
 * signing and broadcast (no ckb-cli dependency).
 *
 * The interim pool's payout path (spec 04 §11): collect the pool's own
 * cells (cellbase outputs to the block-assembler lock), build a transaction
 * with one output per miner, estimate fee from the serialized size, sign
 * with secp256k1_blake160_sighash_all, broadcast via send_transaction.
 *
 * Signing basis (CKB consensus, RFC 0022):
 *   digest = ckb_blake2b(molecule(Transaction)) where the signed witness
 *   group is a Bytes placeholder of 65 zero bytes (signature length);
 *   witness = molecule Bytes(r || s || recovery-id)  (65 bytes).
 * The molecule encoding used is the same code path pinned byte-for-byte
 * against real mainnet transactions (src/mining/ckb-merkle.js).
 *
 * Keys: private keys are passed in-process (payout host only); never
 * logged. The dev-chain drill exercises the full path end-to-end.
 */

const http = require('node:http');
const { ckbBlake2b } = require('../mining/blake2b.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { transaction, rawTransaction, molBytes, script, offsetContainer } = require('../mining/ckb-merkle.js');

/**
 * WitnessArgs { lock: Option<Bytes>, input_type: Option<Bytes>, output_type: Option<Bytes> }
 * — the modern ckb-lib secp256k1_blake160_sighash_all script (bundled in
 * dev/mainnet since ckb 0.115) reads the signature from the `lock` field.
 */
function witnessArgs(lockBytesHex) {
  const lock = lockBytesHex ? molBytes(lockBytesHex) : Buffer.alloc(0);
  return offsetContainer([lock, Buffer.alloc(0), Buffer.alloc(0)]);
}

function rpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({
      host: u.hostname, port: u.port || 8114, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try {
          const msg = JSON.parse(d);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('rpc timeout')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function lockOf(pubkeyCompressedHex) {
  return {
    code_hash: SIGHASH_ALL_TYPE_HASH,
    hash_type: 'type',
    args: '0x' + ckbBlake2b(Buffer.from(pubkeyCompressedHex, 'hex')).subarray(0, 20).toString('hex'),
  };
}

const SIGHASH_ALL_TYPE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
const SECP_DATA_HASH = '0x9799bee251b975b82c45a02154ce28cec89c5853ecc14d12b7b8cccfc19e0af4';

/**
 * Resolve the secp256k1_blake160_sighash_all cell deps from the genesis.
 * Mainnet/testnet: a dep GROUP cell whose type-script hash is the sighash
 * type hash and whose data is an outpoint vector. Dev chain: the same type
 * hash sits on the CODE cell (TYPE_ID script) — use code deps for the code
 * cell + the secp data cell instead (the dev genesis has no dep groups).
 */
async function resolveSecpDeps(nodeUrl) {
  const genesis = await rpc(nodeUrl, 'get_block_by_number', ['0x0']);
  const genesisTxHash = genesis.transactions[0].hash;
  const outs = genesis.transactions[0].outputs;
  const data = genesis.transactions[0].outputs_data;
  for (let i = 0; i < outs.length; i++) {
    const t = outs[i].type;
    if (!t) continue;
    const scriptHash = ckbBlake2b(script(t)).toString('hex');
    if ('0x' + scriptHash !== SIGHASH_ALL_TYPE_HASH) continue;
    const d = Buffer.from((data[i] || '0x').slice(2), 'hex');
    if (d.length >= 4 && d.length % 36 === 4 && d.readUInt32LE(0) > 0 && d.readUInt32LE(0) <= 8) {
      // outpoint vector → dep group cell
      return [{ out_point: { tx_hash: genesisTxHash, index: '0x' + i.toString(16) }, dep_type: 'dep_group' }];
    }
    // ELF code cell → find the secp data cell (matched by its data hash —
    // the dev genesis data cell carries no type script) and use code deps
    const dataCell = outs.findIndex((o, j) => {
      if (o.type) return false;
      const d = Buffer.from((data[j] || '0x').slice(2), 'hex');
      return d.length > 0 && ckbBlake2b(d).toString('hex') === SECP_DATA_HASH.slice(2);
    });
    if (dataCell >= 0) {
      return [
        { out_point: { tx_hash: genesisTxHash, index: '0x' + i.toString(16) }, dep_type: 'code' },
        { out_point: { tx_hash: genesisTxHash, index: '0x' + dataCell.toString(16) }, dep_type: 'code' },
      ];
    }
    throw new Error('sighash_all code cell found but no secp data cell');
  }
  // structural fallback: standard chains put the group at index 1
  return [{ out_point: { tx_hash: genesisTxHash, index: '0x1' }, dep_type: 'dep_group' }];
}

/**
 * Collect the pool's own cells.
 *
 * Primary (production): the ckb-indexer `get_cells` RPC when
 * `indexerUrl` is provided — O(1) per query, paginated, live cells only.
 *
 * Fallback (dev chains / no indexer): scan the pool's own cellbases
 * backward from the tip in chunks until `minCapacity` is covered (correct
 * for a pool that assembles all its blocks; O(history) per payout).
 */
async function collectPoolCells({ nodeUrl, indexerUrl = null, lock, minCapacity = 0n, maxScanBlocks = 5000 }) {
  if (indexerUrl) {
    return collectCellsFromIndexer(indexerUrl, lock);
  }
  const cells = [];
  const spent = new Set();   // "tx_hash:index" of inputs spent by committed txs
  let covered = 0n;
  const tip = await rpc(nodeUrl, 'get_tip_header', []);
  let height = parseInt(tip.number, 16);
  const CHUNK = 100;
  while (height > 0 && cells.length < 500 && height > Math.max(0, parseInt(tip.number, 16) - maxScanBlocks)) {
    const from = Math.max(0, height - CHUNK);
    const promises = [];
    for (let h = height; h > from; h--) {
      promises.push(rpc(nodeUrl, 'get_block_by_number', ['0x' + h.toString(16)]).then(b => ({ h, b })).catch(() => null));
    }
    const blocks = await Promise.all(promises);
    for (const { b } of blocks.filter(Boolean).sort((x, y) => y.h - x.h)) {
      // mark inputs of every non-cellbase tx as spent
      for (let ti = 1; ti < b.transactions.length; ti++) {
        for (const inp of b.transactions[ti].inputs || []) {
          spent.add(`${inp.previous_output.tx_hash}:${inp.previous_output.index}`);
        }
      }
      const cb = b.transactions[0];
      for (let i = 0; i < cb.outputs.length; i++) {
        const out = cb.outputs[i];
        if (out.lock && out.lock.code_hash === lock.code_hash && out.lock.args === lock.args) {
          if (spent.has(`${cb.hash}:0x${i.toString(16)}`)) continue;   // already spent
          cells.push({
            tx_hash: cb.hash,
            index: '0x' + i.toString(16),
            capacity: BigInt(out.capacity),
            data: cb.outputs_data[i] || '0x',
          });
          covered += BigInt(out.capacity);
        }
      }
    }
    height = from;
    if (covered >= minCapacity) break;
  }
  return cells;
}

/** ckb-indexer get_cells (paginated by the `after` cursor). */
async function collectCellsFromIndexer(indexerUrl, lock) {
  const cells = [];
  let after = null;
  for (let page = 0; page < 200; page++) {
    const params = {
      script: { code_hash: lock.code_hash, hash_type: lock.hash_type, args: lock.args },
      script_type: 'lock',
      filter: null,
      with_data: false,
      order: 'desc',
      limit: '0x64',
    };
    if (after) params.after = after;
    const res = await rpc(indexerUrl, 'get_cells', [params]);
    for (const c of res.objects || []) {
      cells.push({
        tx_hash: c.out_point.tx_hash,
        index: c.out_point.index,
        capacity: BigInt(c.output.capacity),
        data: '0x',
      });
    }
    if (!res.last_cursor || (res.objects || []).length === 0) break;
    after = res.last_cursor;
  }
  return cells;
}

function estimateSize(numInputs, numOutputs) {
  // molecule: 4 header + 4*7 offsets + inputs fixvec + outputs dynvec + data
  return 4 + 28 + numInputs * 44 + numOutputs * 85 + 8 + numOutputs * 4 + 4 + 65 + 4 + 4;
}

/**
 * Build, sign and broadcast a payout transaction.
 * @param {object} p
 * @param {string} p.rpcUrl
 * @param {Buffer} p.privateKey
 * @param {Array<{address:string, capacityShannons:string|null}>} p.toAddresses
 *   capacityShannons null → sweep (remainder minus fee goes to change back
 *   to the pool; only one null recipient allowed)
 * @param {number} p.feeRateShannons   fee per byte (dev chain: 1000)
 * @returns {Promise<{txHash:string, inputs:number, outputs:Array, feeShannons:string}>}
 */
async function buildAndSendPayout({ rpcUrl, privateKey, toAddresses, feeRateShannons = 1000, indexerUrl = null }) {
  const pub = secp256k1.getPublicKey(privateKey, true);
  const lock = lockOf(Buffer.from(pub).toString('hex'));
  const cellDeps = await resolveSecpDeps(rpcUrl);

  const sweepTargets = toAddresses.filter(a => a.capacityShannons === null);
  if (sweepTargets.length > 1) throw new Error('only one sweep recipient allowed');
  const fixedSum = toAddresses.filter(a => a.capacityShannons !== null)
    .reduce((a, t) => a + BigInt(t.capacityShannons), 0n);
  // collect enough cells to cover the fixed outputs + fee (fee ≈ size × rate)
  const estFee = BigInt(estimateSize(200, toAddresses.length + 1)) * BigInt(feeRateShannons);
  const minCapacity = fixedSum + estFee;
  const cells = await collectPoolCells({ nodeUrl: rpcUrl, indexerUrl, lock, minCapacity });
  if (cells.length === 0) throw new Error('no pool cells found to spend');

  // decode recipient addresses → lock scripts (short ckt/ckb payloads)
  const { bech32Decode } = require('../stratum/username.js');
  const targets = toAddresses.map(a => {
    const dec = bech32Decode(a.address);
    if (!dec || dec.data[0] !== 0x01) throw new Error(`unsupported address payload: ${a.address}`);
    const idx = dec.data[1];
    const args = dec.data.slice(2);
    const codeHashes = { 0x00: SIGHASH_ALL_TYPE_HASH };
    if (!codeHashes[idx]) throw new Error(`unsupported code_hash_index ${idx}`);
    return {
      address: a.address,
      capacityShannons: a.capacityShannons !== null ? BigInt(a.capacityShannons) : null,
      lock: { code_hash: codeHashes[idx], hash_type: 'type', args: '0x' + Buffer.from(args).toString('hex') },
    };
  });

  const totalIn = cells.reduce((a, c) => a + c.capacity, 0n);
  const fixedOuts = targets.filter(t => t.capacityShannons !== null);
  const sweepIdx = targets.findIndex(t => t.capacityShannons === null);
  const sweepTarget = sweepIdx >= 0 ? targets[sweepIdx] : null;

  // fee + change: one iteration (change only when sweeping)
  const numOuts = fixedOuts.length + (sweepTarget ? 2 : 1);   // +change back to pool
  const size = estimateSize(cells.length, numOuts);
  const fee = BigInt(size) * BigInt(feeRateShannons);
  const fixedSum2 = fixedOuts.reduce((a, t) => a + t.capacityShannons, 0n);
  const sweepAmount = sweepTarget ? (totalIn - fixedSum2 - fee) : 0n;
  if (sweepAmount < 0n) throw new Error(`insufficient funds: in=${totalIn} out=${fixedSum2} fee=${fee}`);

  const outputs = [...fixedOuts.map(t => ({ capacity: '0x' + t.capacityShannons.toString(16), lock: t.lock, type: null }))];
  const outputsData = fixedOuts.map(() => '0x');
  if (sweepTarget) {
    outputs.push({ capacity: '0x' + sweepAmount.toString(16), lock: sweepTarget.lock, type: null });
    outputsData.push('0x');
    if (totalIn - fixedSum2 - sweepAmount - fee > 0n) {
      outputs.push({ capacity: '0x' + (totalIn - fixedSum2 - sweepAmount - fee).toString(16), lock, type: null });
      outputsData.push('0x');
    }
  }

  // digest: RFC 0022 sighash_all message —
  //   blake2b( txHash(molecule RawTransaction)
  //            || u64le(len) || witness0          (the signed group's witness,
  //               with the lock placeholder = 65 zero bytes)
  //            || u64le(len) || witness1 ... )    (remaining witnesses)
  // (matches ckb-system-scripts secp256k1_blake160_sighash_all and the
  // ckb-lib script bundled in current chains)
  const tx = {
    version: '0x0',
    cell_deps: cellDeps,
    header_deps: [],
    inputs: cells.map(c => ({ since: '0x0', previous_output: { tx_hash: c.tx_hash, index: c.index } })),
    outputs,
    outputs_data: outputsData,
  };
  const zeroWitness = witnessArgs('0x' + '00'.repeat(65));
  const txHash = ckbBlake2b(rawTransaction(tx));
  const u64le = n => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const message = Buffer.concat([
    txHash,
    u64le(zeroWitness.length), zeroWitness,
    // no remaining witnesses in a single-input-group payout
  ]);
  const digest = ckbBlake2b(message);

  const compactSig = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true });
  if (compactSig.length !== 64) throw new Error(`unexpected signature length ${compactSig.length}`);
  let signatureBytes = null;
  for (const rec of [0, 1]) {
    // this noble version's 'recovered' format is [recid][r||s]
    const candidate = Buffer.concat([Buffer.from([rec]), Buffer.from(compactSig)]);
    try {
      const recovered = secp256k1.recoverPublicKey(candidate, digest, { prehash: false });
      if (Buffer.from(recovered).equals(Buffer.from(pub))) {
        signatureBytes = Buffer.concat([Buffer.from(compactSig), Buffer.from([rec])]); // CKB witness: r||s||v
        break;
      }
    } catch { /* wrong recid */ }
  }
  if (!signatureBytes) throw new Error('could not determine recovery id');
  const finalTx = {
    ...tx,
    witnesses: ['0x' + witnessArgs('0x' + signatureBytes.toString('hex')).toString('hex')],
  };

  const sentHash = await rpc(rpcUrl, "send_transaction", [finalTx]);
  return {
    txHash: sentHash,
    inputs: cells.length,
    outputs: outputs.map(o => ({ capacity: o.capacity.toString(), lock: o.lock })),
    feeShannons: fee.toString(),
  };
}

/**
 * One signed transaction for a whole payout batch (spec 04 §11 batching):
 * every item is a fixed-capacity output; inputs = the pool's cells; the
 * remainder after outputs + estimated fee stays implicit (fee = residual).
 */
async function buildAndSendBatchPayout({ rpcUrl, privateKey, items, feeRateShannons = 1000, indexerUrl = null }) {
  return buildAndSendPayout({
    rpcUrl,
    privateKey,
    indexerUrl,
    feeRateShannons,
    toAddresses: items.map(i => ({ address: i.address, capacityShannons: i.capacityShannons })),
  });
}

module.exports = { buildAndSendPayout, buildAndSendBatchPayout, collectPoolCells, collectCellsFromIndexer, lockOf, estimateSize };
