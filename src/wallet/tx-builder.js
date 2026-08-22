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
const {
  parseEpochFields,
  classifyCells,
  selectOldestFirst,
  collectLiveCells,
} = require('./cells.js');
const { spendableSplit } = require('./treasury.js');
const { decodeRecipientAddress, SIGHASH_ALL_TYPE_HASH } = require('./address.js');
const { assertRecipientsPayable } = require('./dust.js');

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
      timeout: 180000,
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

const SECP_DATA_HASH = '0x9799bee251b975b82c45a02154ce28cec89c5853ecc14d12b7b8cccfc19e0af4';
const MIN_SIGHASH_CELL_SHANNONS = 6_100_000_000n;


/**
 * Resolve the secp256k1_blake160_sighash_all cell deps from the genesis.
 * Mainnet/testnet: a dep GROUP cell whose type-script hash is the sighash
 * type hash and whose data is an outpoint vector. Dev chain: the same type
 * hash sits on the CODE cell (TYPE_ID script) — use code deps for the code
 * cell + the secp data cell instead (the dev genesis has no dep groups).
 *
 * Cached per node: the genesis is immutable, and on slow nodes (Orange Pi
 * class hardware) the 2.4MB `get_block_by_number("0x0")` response can take
 * over a minute — every payout build re-fetching it is what timed out the
 * first armed tick on mainnet (2026-08-19).
 */
const secpDepsCache = new Map();
async function resolveSecpDeps(nodeUrl) {
  if (secpDepsCache.has(nodeUrl)) return secpDepsCache.get(nodeUrl);
  const deps = await resolveSecpDepsUncached(nodeUrl);
  secpDepsCache.set(nodeUrl, deps);
  return deps;
}

async function resolveSecpDepsUncached(nodeUrl) {
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
 * Fallback (dev chains / no indexer): scan the pool's own cellbases backward
 * from the tip, then apply the same maturity and oldest-first rules (correct
 * for a pool that assembles all its blocks; O(history) per payout).
 */
async function collectPoolCells({
  nodeUrl,
  indexerUrl = null,
  lock,
  minCapacity = 0n,
  maxScanBlocks = 5000,
  rpcClient = rpc,
}) {
  if (indexerUrl) {
    const tip = await rpcClient(nodeUrl, 'get_tip_header', []);
    if (!tip?.epoch) throw new Error('node returned no tip epoch');
    const rawCells = await collectLiveCells({ indexerUrl, nodeUrl, lock, rpc: rpcClient });
    const { selected } = selectMaturePoolCells({
      rawCells,
      tipEpochHex: tip.epoch,
      targetShannons: minCapacity.toString(),
    });
    return selected.map(cell => ({
      tx_hash: cell.outPoint.tx_hash,
      index: cell.outPoint.index,
      capacity: BigInt(cell.capacity),
      data: '0x',
    }));
  }
  const rawCells = [];
  const spent = new Set();   // "tx_hash:index" of inputs spent by committed txs
  const tip = await rpcClient(nodeUrl, 'get_tip_header', []);
  if (!tip?.epoch) throw new Error('node returned no tip epoch');
  let height = parseInt(tip.number, 16);
  const CHUNK = 100;
  while (height > 0 && rawCells.length < 500 &&
         height > Math.max(0, parseInt(tip.number, 16) - maxScanBlocks)) {
    const from = Math.max(0, height - CHUNK);
    const promises = [];
    for (let h = height; h > from; h--) {
      promises.push(rpcClient(nodeUrl, 'get_block_by_number', ['0x' + h.toString(16)])
        .then(b => ({ h, b })).catch(() => null));
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
          rawCells.push({
            output: { capacity: out.capacity },
            block_number: b.header.number,
            block_epoch: b.header.epoch,
            tx_index: '0x0',
            out_point: { tx_hash: cb.hash, index: '0x' + i.toString(16) },
          });
        }
      }
    }
    height = from;
  }
  const { selected } = selectMaturePoolCells({
    rawCells,
    tipEpochHex: tip.epoch,
    targetShannons: minCapacity.toString(),
  });
  return selected.map(cell => ({
    tx_hash: cell.outPoint.tx_hash,
    index: cell.outPoint.index,
    capacity: BigInt(cell.capacity),
    data: '0x',
  }));
}

/** Filter by full fractional epoch maturity, then cover the target oldest-first. */
function selectMaturePoolCells({ rawCells, tipEpochHex, targetShannons }) {
  const tipEpoch = parseEpochFields(tipEpochHex);
  const classified = classifyCells(rawCells);
  const mature = classified.filter(cell => {
    if (!cell.isCellbase) return true;
    return BigInt(spendableSplit({ cells: [cell], tipEpoch }).spendable) > 0n;
  });
  const result = selectOldestFirst(mature, targetShannons);
  if (BigInt(result.total) < BigInt(targetShannons)) {
    throw new Error(
      `mature cells cannot cover ${targetShannons} shannons (available ${result.total})`);
  }
  return result;
}

function estimateSize(numInputs, numOutputs) {
  // molecule: 4 header + 4*7 offsets + inputs fixvec + outputs dynvec + data
  return 4 + 28 + numInputs * 44 + numOutputs * 85 + 8 + numOutputs * 4 + 4 + 65 + 4 + 4;
}

/** Preserve fixed-payout excess as change; only sub-cell dust becomes fee. */
function planPayoutAmounts({
  totalIn,
  fixedAmounts,
  estimatedFee,
  sweep,
  minChangeShannons = MIN_SIGHASH_CELL_SHANNONS,
}) {
  const input = BigInt(totalIn);
  const fee = BigInt(estimatedFee);
  const minimum = BigInt(minChangeShannons);
  const fixedSum = fixedAmounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
  const remainder = input - fixedSum - fee;
  if (remainder < 0n) {
    throw new Error(`insufficient funds: in=${input} out=${fixedSum} fee=${fee}`);
  }
  if (sweep) {
    if (remainder < minimum) {
      throw new Error(`sweep output ${remainder} is below minimum cell capacity ${minimum}`);
    }
    return { fixedSum, sweepAmount: remainder, changeAmount: 0n, actualFee: fee };
  }
  if (remainder >= minimum) {
    return { fixedSum, sweepAmount: null, changeAmount: remainder, actualFee: fee };
  }
  return {
    fixedSum,
    sweepAmount: null,
    changeAmount: 0n,
    actualFee: fee + remainder,
  };
}

/**
 * Build and sign a payout transaction without broadcasting it. The raw
 * transaction hash is known before send_transaction, which lets the payout
 * worker persist durable recovery evidence before crossing the network
 * boundary.
 * @param {object} p
 * @param {string} p.rpcUrl
 * @param {Buffer} p.privateKey
 * @param {Array<{address:string, capacityShannons:string|null}>} p.toAddresses
 *   capacityShannons null → sweep (remainder minus fee goes to that target;
 *   only one null recipient allowed)
 * @param {number} p.feeRateShannons   fee per byte (dev chain: 1000)
 * @returns {Promise<{txHash:string, inputs:number, outputs:Array, feeShannons:string}>}
 */
async function buildPayoutTransaction({ rpcUrl, privateKey, toAddresses, feeRateShannons = 1000, indexerUrl = null }) {
  // Before the node is touched: a recipient below its own lock's minimum cell
  // capacity is unconstructible, and discovering that after broadcast costs a
  // persisted signed transaction that recovery must then reconcile.
  assertRecipientsPayable(toAddresses);
  const pub = secp256k1.getPublicKey(privateKey, true);
  const lock = lockOf(Buffer.from(pub).toString('hex'));
  const cellDeps = await resolveSecpDeps(rpcUrl);

  const sweepTargets = toAddresses.filter(a => a.capacityShannons === null);
  if (sweepTargets.length > 1) throw new Error('only one sweep recipient allowed');
  const fixedSum = toAddresses.filter(a => a.capacityShannons !== null)
    .reduce((a, t) => a + BigInt(t.capacityShannons), 0n);
  // collect enough cells to cover the fixed outputs + fee (fee ≈ size × rate)
  const estFee = BigInt(estimateSize(200, toAddresses.length + 1)) * BigInt(feeRateShannons);
  // Every transaction needs one additional standard-lock output: treasury
  // change for a fixed payout, or the sweep destination. Selecting enough
  // for its occupied capacity avoids turning a near-threshold remainder into
  // a large dust fee when more mature inputs are available.
  const minCapacity = fixedSum + estFee + MIN_SIGHASH_CELL_SHANNONS;
  const cells = await collectPoolCells({ nodeUrl: rpcUrl, indexerUrl, lock, minCapacity });
  if (cells.length === 0) throw new Error('no pool cells found to spend');

  // decode recipient addresses → lock scripts (short ckt/ckb payloads)
  const targets = toAddresses.map(a => {
    return {
      address: a.address,
      capacityShannons: a.capacityShannons !== null ? BigInt(a.capacityShannons) : null,
      lock: decodeRecipientAddress(a.address),
    };
  });

  const totalIn = cells.reduce((a, c) => a + c.capacity, 0n);
  const fixedOuts = targets.filter(t => t.capacityShannons !== null);
  const sweepIdx = targets.findIndex(t => t.capacityShannons === null);
  const sweepTarget = sweepIdx >= 0 ? targets[sweepIdx] : null;

  // One extra output is either treasury change or the sweep destination.
  const numOuts = fixedOuts.length + 1;
  const size = estimateSize(cells.length, numOuts);
  const fee = BigInt(size) * BigInt(feeRateShannons);
  const amounts = planPayoutAmounts({
    totalIn,
    fixedAmounts: fixedOuts.map(target => target.capacityShannons),
    estimatedFee: fee,
    sweep: Boolean(sweepTarget),
  });

  const outputs = [...fixedOuts.map(t => ({ capacity: '0x' + t.capacityShannons.toString(16), lock: t.lock, type: null }))];
  const outputsData = fixedOuts.map(() => '0x');
  if (sweepTarget) {
    outputs.push({
      capacity: '0x' + amounts.sweepAmount.toString(16),
      lock: sweepTarget.lock,
      type: null,
    });
    outputsData.push('0x');
  } else if (amounts.changeAmount > 0n) {
    outputs.push({
      capacity: '0x' + amounts.changeAmount.toString(16),
      lock,
      type: null,
    });
    outputsData.push('0x');
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

  return {
    txHash: '0x' + txHash.toString('hex'),
    rawTx: finalTx,
    inputs: cells.length,
    outputs: outputs.map(o => ({ capacity: o.capacity.toString(), lock: o.lock })),
    feeShannons: amounts.actualFee.toString(),
  };
}

/** Broadcast an already-signed transaction and reject unexpected hash drift. */
async function broadcastPayout({ rpcUrl, rawTx, expectedTxHash = null }) {
  const sentHash = await rpc(rpcUrl, 'send_transaction', [rawTx]);
  if (expectedTxHash && sentHash !== expectedTxHash) {
    throw new Error(`node returned transaction hash ${sentHash}, expected ${expectedTxHash}`);
  }
  return { ok: true, txHash: sentHash };
}

/** Compatibility helper for drills and direct callers. */
async function buildAndSendPayout(options) {
  const built = await buildPayoutTransaction(options);
  const sent = await broadcastPayout({
    rpcUrl: options.rpcUrl,
    rawTx: built.rawTx,
    expectedTxHash: built.txHash,
  });
  return { ...built, txHash: sent.txHash };
}

/**
 * One signed transaction for a whole payout batch (spec 04 §11 batching):
 * every item is a fixed-capacity output; inputs = the pool's cells; the
 * input excess after outputs and the bounded fee returns to the treasury lock.
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

async function buildBatchPayout({ rpcUrl, privateKey, items, feeRateShannons = 1000, indexerUrl = null }) {
  return buildPayoutTransaction({
    rpcUrl,
    privateKey,
    indexerUrl,
    feeRateShannons,
    toAddresses: items.map(i => ({ address: i.address, capacityShannons: i.capacityShannons })),
  });
}

module.exports = {
  buildPayoutTransaction,
  buildBatchPayout,
  broadcastPayout,
  buildAndSendPayout,
  buildAndSendBatchPayout,
  collectPoolCells,
  selectMaturePoolCells,
  planPayoutAmounts,
  lockOf,
  estimateSize,
  decodeRecipientAddress,
};
